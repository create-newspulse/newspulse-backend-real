const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { cleanupOldLowPrioritySubmissions } = require('../services/communityCleanup');
const { createDraftArticleFromSubmission } = require('../services/communityDraftFromSubmission');
const { shouldLog } = require('../lib/logThrottle');

const router = express.Router();

// Shared auth now handled by requireAdminAuth middleware.

// Optional internal key enforcement (strict only in production)
function requireInternalAdminKey(req, res, next) {
  const expected = (process.env.ADMIN_INTERNAL_KEY || '').trim();
  const provided = (req.headers['x-admin-internal-key'] || '').trim();
  const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
  if (!expected) {
    // No key configured: allow but log occasionally in production for visibility
    if (isProd && shouldLog('admin.communityReporter.internalKey.missing', 60_000)) {
      console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] expected key not set (production)');
    }
    return next();
  }
  if (isProd) {
    if (!provided || provided !== expected) {
      if (shouldLog('admin.communityReporter.internalKey.invalid', 60_000)) {
        console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] invalid or missing key (production)');
      }
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return next();
  }
  // Non-production: allow if missing, log relaxation
  if (!provided || provided !== expected) {
    console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] relaxed check (non-production)');
  }
  return next();
}

// GET /admin/community-reporter/submissions (mounted at /admin/community-reporter)
// Also available at /api/admin/community-reporter/submissions
function externalStatus(internal) {
  switch (internal) {
    case 'NEW': return 'pending';
    case 'APPROVED': return 'approved';
    case 'REJECTED': return 'rejected';
    default: return 'pending';
  }
}

router.get('/submissions', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { status, priority, search, page, limit } = req.query || {};

    // Base filter (exclude archived unless explicitly trash)
    const filter = { isArchived: { $ne: true } };

    // Status filter: if provided and not 'all'
    const allowedStatuses = new Set(['pending', 'approved', 'rejected', 'trash']);
    if (status && status !== 'all') {
      const normalizedStatus = String(status).trim().toLowerCase();
      if (allowedStatuses.has(normalizedStatus)) {
        // Pending Review should include multiple internal statuses (migration-safe)
        if (normalizedStatus === 'pending') filter.status = { $in: ['pending', 'new', 'AI_REVIEWED', 'PENDING_FOUNDER'] };
        else if (normalizedStatus === 'approved') filter.status = 'APPROVED';
        else if (normalizedStatus === 'rejected') filter.status = 'REJECTED';
        else if (normalizedStatus === 'trash') {
          // Use archived flag for trash view
          delete filter.isArchived;
          filter.isArchived = true;
        }
      }
    }

    // Priority filter
    if (priority && priority !== 'all') {
      const normalizedPriority = String(priority).trim().toUpperCase();
      const allowedPriorities = new Set(['FOUNDER_REVIEW', 'EDITOR_REVIEW', 'LOW_PRIORITY']);
      if (allowedPriorities.has(normalizedPriority)) {
        filter.priority = normalizedPriority;
      }
    }

    // Search filter (headline/body case-insensitive regex)
    if (search && String(search).trim()) {
      const term = String(search).trim();
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { headline: regex },
        { body: regex },
      ];
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Total count (without pagination)
    const total = await CommunitySubmission.countDocuments(filter);

    // Query with projection
      const raw = await CommunitySubmission
        .find(
          filter,
          '_id name email city location category headline body status priority linkedArticleId aiHeadline aiBody riskScore flags createdAt updatedAt'
        )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const items = raw.map(r => ({
      id: r._id.toString(),
      _id: r._id,
      name: r.name,
      userName: r.name, // alias for UI expectations
      email: r.email,
      location: r.location,
      locationDetail: r.locationDetail || null,
      category: r.category,
      headline: r.headline,
      body: r.body,
      status: (function mapStatus(s){
        if (s === 'NEW' || s === 'pending' || s === 'new' || s === 'AI_REVIEWED' || s === 'PENDING_FOUNDER') return 'pending';
        if (s === 'APPROVED') return 'approved';
        if (s === 'REJECTED') return 'rejected';
        return s;
      })(r.status),
      priority: r.priority,
      linkedArticleId: r.linkedArticleId || null,
      aiHeadline: r.aiHeadline,
      aiBody: r.aiBody,
      riskScore: r.riskScore,
      flags: Array.isArray(r.flags) ? r.flags : [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      contact: r.contact ? {
        name: r.contact.name || null,
        email: r.contact.email || null,
        phone: r.contact.phone || null,
        preferredContact: r.contact.preferredContact || 'no_preference',
      } : null,
    }));

    return res.status(200).json({
      ok: true,
      success: true,
      items,
      submissions: items, // legacy key expected by some clients
      data: items, // extra alias for older callers
      page: pageNum,
      limit: limitNum,
      total,
    });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load submissions' });
  }
});

// GET /api/admin/community-reporter/submissions/:id (detail)
router.get('/submissions/:id', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: 'Invalid submission id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ message: 'Invalid submission id' });
    const submission = await CommunitySubmission.findOne({ _id: id, isArchived: { $ne: true } }).lean();
    if (!submission) return res.status(404).json({ message: 'Submission not found' });
    return res.json({ submission });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][detail-error]', e?.message || e);
    return res.status(500).json({ message: 'Failed to load submission' });
  }
});

// PATCH approve
router.patch('/submissions/:id/approve', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ success: false, message: 'Not found' });

    submission.status = 'APPROVED';
    await submission.save();

    try {
      const ActivityLog = require('../models/ActivityLog');
      await ActivityLog.create({ type: 'community_approve', email: req.admin?.email || 'admin', meta: { submissionId: submission._id.toString() } });
    } catch (_) {}

    let draftArticle = null;
    try {
      const result = await createDraftArticleFromSubmission(submission._id.toString());
      draftArticle = result.article;
      console.log('[ADMIN_COMMUNITY_REPORTER][approve->draft]', {
        submissionId: submission._id.toString(),
        articleId: draftArticle?._id?.toString() || null,
        status: draftArticle?.status,
      });
    } catch (draftErr) {
      console.error('[ADMIN_COMMUNITY_REPORTER][approve-draft-error]', draftErr?.message || draftErr);
      return res.status(500).json({ ok: false, message: 'Failed to create draft article from submission' });
    }

    return res.json({
      ok: true,
      submission,
      article: draftArticle || null,
      // keep backward compatibility for any callers expecting this name
      draftArticle: draftArticle || null,
    });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][approve-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to approve submission' });
  }
});

// PATCH reject
router.patch('/submissions/:id/reject', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ success: false, message: 'Not found' });
    submission.status = 'REJECTED';
    await submission.save();
    try {
      const ActivityLog = require('../models/ActivityLog');
      await ActivityLog.create({ type: 'community_reject', email: req.admin?.email || 'admin', meta: { submissionId: submission._id.toString() } });
    } catch (_) {}
    return res.json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
      status: externalStatus(submission.status),
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    }});
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][reject-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to reject submission' });
  }
});

// POST /admin/community-reporter/submissions/:id/decision { action: 'approve' | 'reject' }
router.post('/submissions/:id/decision', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    let { decision, action } = req.body || {};
    // normalize decision (support previous 'action')
    decision = decision || action;
    if (!id) return res.status(400).json({ message: 'Invalid submission id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ message: 'Invalid submission id' });
    if (!decision) return res.status(400).json({ message: 'Invalid decision' });
    const normalized = String(decision).trim().toUpperCase();
    const approveSet = new Set(['APPROVE', 'APPROVED']);
    const rejectSet = new Set(['REJECT', 'REJECTED']);
    let mappedStatus = null;
    if (approveSet.has(normalized)) mappedStatus = 'APPROVED';
    else if (rejectSet.has(normalized)) mappedStatus = 'REJECTED';
    else return res.status(400).json({ message: 'Invalid decision' });

    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ message: 'Submission not found' });
    submission.status = mappedStatus;
    if (mappedStatus === 'APPROVED') {
      submission.rejectReason = undefined;
    } else if (mappedStatus === 'REJECTED' && !submission.rejectReason) {
      submission.rejectReason = 'Rejected';
    }
    await submission.save();

    let draftArticle = null;
    if (mappedStatus === 'APPROVED') {
      try {
        const result = await createDraftArticleFromSubmission(submission._id.toString());
        draftArticle = result.article;
        console.log('[ADMIN_COMMUNITY_REPORTER][decision-approve->draft]', {
          submissionId: submission._id.toString(),
          articleId: draftArticle?._id?.toString() || null,
          status: draftArticle?.status,
        });
      } catch (draftErr) {
        console.error('[ADMIN_COMMUNITY_REPORTER][decision-approve-draft-error]', draftErr?.message || draftErr);
        return res.status(500).json({ ok: false, message: 'Failed to create draft article from submission' });
      }
    }
    return res.json({ submission, draftArticle });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][decision-error]', e?.message || e);
    return res.status(500).json({ message: 'Server error updating submission' });
  }
});

// POST /api/admin/community-reporter/submissions/:id/restore
// Soft restore: only allowed when current internal status is REJECTED (external 'rejected').
// Restores by setting status back to NEW (external 'pending').
router.post('/submissions/:id/restore', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: 'Invalid submission id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ message: 'Invalid submission id' });
    const submission = await CommunitySubmission.findOne({ _id: id, isArchived: { $ne: true } });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });
    if (submission.status !== 'REJECTED') {
      return res.status(400).json({ message: 'Only rejected submissions can be restored' });
    }
    submission.status = 'NEW';
    await submission.save();
    return res.json({ ok: true, submission });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][restore-error]', e?.message || e);
    return res.status(500).json({ message: 'Failed to restore submission' });
  }
});

// POST /api/admin/community-reporter/cleanup
router.post('/cleanup', requireAdminAuth, requireInternalAdminKey, async (req, res) => {
  try {
    let { olderThanDays } = req.body || {};
    olderThanDays = Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0
      ? Number(olderThanDays)
      : 30;

    const { deletedCount, cutoffDate } = await cleanupOldLowPrioritySubmissions({ olderThanDays });

    return res.json({
      ok: true,
      olderThanDays,
      deletedCount,
      cutoffDate,
    });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][cleanup-error]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'CLEANUP_FAILED' });
  }
});

module.exports = router;