const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { cleanupOldLowPrioritySubmissions } = require('../services/communityCleanup');
const { createDraftArticleFromSubmission } = require('../services/communityDraftFromSubmission');

const router = express.Router();

// Shared auth now handled by requireAdminAuth middleware.

// Optional internal key enforcement (strict only in production)
function requireInternalAdminKey(req, res, next) {
  const expected = (process.env.ADMIN_INTERNAL_KEY || '').trim();
  const provided = (req.headers['x-admin-internal-key'] || '').trim();
  const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
  if (!expected) {
    // No key configured: allow but log once in production for visibility
    if (isProd) console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] expected key not set (production)');
    return next();
  }
  if (isProd) {
    if (!provided || provided !== expected) {
      console.warn('[ADMIN_COMMUNITY_REPORTER][internal-key] invalid or missing key (production)');
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
    console.log('[ADMIN_COMMUNITY_REPORTER][hit]', { adminId: req.admin?.id, role: req.admin?.role });
    const raw = await CommunitySubmission
      .find({ isArchived: { $ne: true } }, '_id name email location category headline status aiHeadline aiBody riskScore flags createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const items = raw.map(r => ({
      id: r._id.toString(),
      name: r.name,
      email: r.email,
      location: r.location,
      category: r.category,
      headline: r.headline,
      aiHeadline: r.aiHeadline,
      aiBody: r.aiBody,
      riskScore: r.riskScore,
      flags: Array.isArray(r.flags) ? r.flags : [],
      status: externalStatus(r.status),
      createdAt: r.createdAt,
    }));
    return res.status(200).json({ submissions: items });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submissions' });
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

    let draftArticle = null;
    try {
      const result = await createDraftArticleFromSubmission(submission._id.toString());
      draftArticle = result.article;
    } catch (draftErr) {
      console.error('[ADMIN_COMMUNITY_REPORTER][approve-draft-error]', draftErr?.message || draftErr);
      return res.status(500).json({ ok: false, message: 'Failed to create draft article from submission' });
    }

    return res.json({
      ok: true,
      submission,
      draftArticle,
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
    return res.json({ submission });
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