const express = require('express');
const { requireAdminAuth, requireFounderOrAdmin } = require('../middleware/adminAuth');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const { addStrikeForReporter } = require('../services/reporterSafetyService');
const News = require('../models/News');
const mongoose = require('mongoose');
const { upsertReporterContact } = require('../services/reporterContactService');

const {
  adminListReporterContacts,
  adminListReporterContactStories,
  backfillReporterContactsFromSubmissions,
  deleteReporterContact,
  deactivateReporterContact,
  reassignReporterContactStories,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  restoreCommunityReporterStory,
  withdrawCommunityReporterStory,
  permanentDeleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
} = require('../controllers/communityReporterController');

const router = express.Router();

// --- Final contract: contacts + stories (ONLY under /api/admin/community-reporter) ---
router.get('/contacts', requireAdminAuth, adminListReporterContacts);
router.get('/contacts/:id/stories', requireAdminAuth, adminListReporterContactStories);
router.post('/contacts/backfill', requireFounderOrAdmin, backfillReporterContactsFromSubmissions);
router.delete('/contacts/:id', requireFounderOrAdmin, deleteReporterContact);
router.post('/contacts/:id/deactivate', requireFounderOrAdmin, deactivateReporterContact);
router.post('/contacts/:id/archive', requireFounderOrAdmin, deactivateReporterContact);
router.post('/contacts/:id/reassign-stories', requireFounderOrAdmin, reassignReporterContactStories);
router.post('/contacts/bulk-delete', requireFounderOrAdmin, bulkDeleteReporterContacts);
// Community stories: two-stage delete model
router.delete('/stories/:storyId', requireAdminAuth, deleteCommunityReporterStory); // soft delete
router.post('/stories/:storyId/restore', requireAdminAuth, restoreCommunityReporterStory);
router.post('/stories/:storyId/withdraw', requireAdminAuth, withdrawCommunityReporterStory);
router.delete('/stories/:storyId/permanent', requireAdminAuth, permanentDeleteCommunityReporterStory);
// Compatibility aliases
router.post('/stories/:storyId/permanent-delete', requireAdminAuth, permanentDeleteCommunityReporterStory);
router.post('/stories/bulk-delete', requireAdminAuth, bulkDeleteCommunityReporterStories);

// Frontend compatibility: some builds treat CommunitySubmission as "submissions" instead of "stories"
router.post('/submissions/:id/soft-delete', requireAdminAuth, deleteCommunityReporterStory);
router.post('/submissions/:id/trash', requireAdminAuth, deleteCommunityReporterStory);
router.post('/submissions/:id/restore', requireAdminAuth, restoreCommunityReporterStory);
router.post('/submissions/:id/withdraw', requireAdminAuth, withdrawCommunityReporterStory);
router.delete('/submissions/:id/permanent', requireAdminAuth, permanentDeleteCommunityReporterStory);
router.post('/submissions/:id/permanent-delete', requireAdminAuth, permanentDeleteCommunityReporterStory);

// Helper: create or update a draft News article from a submission
async function upsertDraftFromSubmission(submission) {
  if (!submission) return null;
  // Skip in test mode or when DB not connected to avoid hanging tests
  if (process.env.NODE_ENV === 'test' || mongoose.connection?.readyState !== 1) {
    return null;
  }

  // Ensure reporter exists in directory and link submission.reporterId
  try {
    const email = String(
      submission.reporterEmailNorm ||
      submission.reporterEmail ||
      submission.email ||
      (submission.contact && submission.contact.email) ||
      ''
    ).trim().toLowerCase();

    const name = String(
      submission.reporterName ||
      submission.name ||
      (submission.contact && submission.contact.name) ||
      ''
    ).trim();

    if (email) {
      const loc = submission.location || submission.locationDetail || {};
      const phone = submission.contact && submission.contact.phone ? String(submission.contact.phone).trim() : '';
      const reporterType = submission.sourceType === 'journalist' ? 'journalist' : 'community';

      const { contactId } = await upsertReporterContact({
        name: name || undefined,
        email,
        phone: phone || undefined,
        city: loc.city || undefined,
        state: loc.state || undefined,
        country: loc.country || undefined,
        reporterType,
        stats: {
          lastStoryAt: submission.createdAt || new Date(),
          lastStoryTitle: submission.headline || undefined,
        },
      });

      if (contactId && !submission.reporterId) {
        try {
          submission.reporterId = contactId;
          await submission.save();
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error('[COMMUNITY][DRAFT_UPSERT][contact-upsert] failed', e?.message || e);
  }

  const safe = (v) => (v == null ? '' : String(v));
  const title = safe(submission.headline) || 'Untitled';
  const body = safe(submission.body || submission.story);
  const category = submission.category || undefined;
  const tags = Array.isArray(submission.aiSuggestedTags) ? submission.aiSuggestedTags : [];

  const deriveDescription = () => {
    const src = body || title;
    const plain = src.replace(/\s+/g, ' ').trim();
    return plain.length > 220 ? plain.slice(0, 217) + '...' : plain;
  };

  let article = null;
  try {
    if (submission.linkedArticleId) {
      try {
        article = await News.findById(submission.linkedArticleId);
      } catch (_) {}
    }
    if (!article) {
      article = await News.findOne({ communityReportId: submission._id });
    }

    if (article) {
      article.title = title;
      article.description = deriveDescription();
      article.content = body;
      if (category !== undefined) article.category = category;
      article.status = 'draft';
      article.language = article.language || 'en';
      article.source = 'community';
      article.communityReportId = submission._id;
      if (tags && tags.length) article.tags = tags;
      await article.save();
    } else {
      article = new News({
        title,
        description: deriveDescription(),
        content: body,
        category,
        tags,
        status: 'draft',
        language: 'en',
        source: 'community',
        communityReportId: submission._id,
      });
      await article.save();
    }
  } catch (e) {
    console.error('[COMMUNITY][DRAFT_UPSERT][error]', e?.message || e);
    return null;
  }
  return article;
}

// Placeholder admin community-reporter routes to ensure server boots.
// Keep responses minimal; real implementations can extend these.
router.get('/submissions', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;
    const { source, q } = req.query || {};

    // Map external status query to internal statuses. Default missing to "pending" grouping.
    const rawStatus = (req.query.status || 'pending').toString().toLowerCase();
    let statusFilter; // either {$in: [...]} or direct equality string or undefined
    if (rawStatus === 'pending') {
      statusFilter = { $in: ['pending', 'PENDING_FOUNDER', 'under_review'] };
    } else if (rawStatus === 'rejected') {
      statusFilter = { $in: ['rejected', 'REJECTED'] };
    } else if (rawStatus === 'approved') {
      statusFilter = { $in: ['approved', 'APPROVED'] };
    } else if (rawStatus === 'all') {
      // No status restriction (future list views). Safer current default is to leave unfiltered.
      statusFilter = undefined;
    } else {
      // Fallback: treat as direct equality to allow future explicit statuses.
      statusFilter = rawStatus;
    }

    // Base filter: exclude soft-deleted if your schema uses such flags.
    // Note: current schema has no deleted flags; keep placeholder for future.
    const filter = {};

    // Backwards compatibility: submissions without sourceType are treated as community reporters.
    // (Submissions created before reporter directory integration lacked sourceType.)
    if (!source || source === 'all') {
      // no sourceType restriction applied here
    }
    if (source === 'community') {
      filter.$or = [
        { sourceType: 'community' },
        { sourceType: { $exists: false } },
        { sourceType: null },
      ];
    } else if (source === 'journalist' || source === 'journalists' || source === 'verified_journalists') {
      filter.sourceType = 'journalist';
    } // else source=all -> no sourceType restriction

    // Apply status filter if provided
    if (statusFilter !== undefined) {
      filter.status = statusFilter;
    }

    // Optional simple text search on headline or location
    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = (filter.$or || []).concat([
        { headline: regex },
        { reporterLocation: regex },
        { 'location.city': regex },
        { 'locationDetail.city': regex },
        { city: regex },
      ]);
    }

    const query = CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const [items, total] = await Promise.all([
      query.lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const mapped = items.map(s => {
      const reporterName = s.reporterName || s.name || (s.contact && s.contact.name) || null;
      const reporterEmail = s.reporterEmailNorm || s.reporterEmail || s.email || (s.contact && s.contact.email) || null;
      const locationObj = s.location || s.locationDetail || null;
      const locationText = s.reporterLocation || (locationObj && locationObj.city) || s.city || null;

      return {
        id: s._id.toString(),
        headline: s.headline,
        story: s.body,
        category: s.category,
        location: locationText,
        locationObj,
        status: s.status,
        sourceType: s.sourceType || 'community', // compatibility default
        reporterVerificationLevel: s.reporterVerificationLevel || 'community_default',
        reporterId: s.reporterId || null,
        reporterName,
        reporterEmail,
        reporterPhone: (s.contact && s.contact.phone) || null,
        riskScore: s.riskScore || 0,
        flags: s.flags || [],
        createdAt: s.createdAt,
      };
    });

    console.log('[ADMIN_COMMUNITY][list] rawStatus=%s, appliedStatusFilter=%j, count=%d', rawStatus, statusFilter, mapped.length);

    // Response shape expected by admin UI
    return res.json({ success: true, submissions: mapped, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][submissions] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});

// GET /admin/community/journalist-applications
router.get('/journalist-applications', requireAdminAuth, async (req, res) => {
  try {
    const { status = 'pending' } = req.query || {};
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    const filter = { reporterType: 'journalist' };
    if (status) filter.verificationLevel = status;

    const [items, total] = await Promise.all([
      ReporterContact.find(filter).sort({ verifiedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    const enriched = await Promise.all(items.map(async (c) => {
      let storiesCount = 0;
      try { storiesCount = await CommunitySubmission.countDocuments({ reporterId: c._id }); } catch (_) {}
      return {
        _id: c._id,
        id: c._id.toString(),
        name: c.fullName || null,
        email: c.email || null,
        phone: c.phoneFull || null,
        city: c.cityTownVillage || null,
        state: c.stateName || null,
        country: c.country || null,
        reporterType: c.reporterType,
        verificationLevel: c.verificationLevel,
        status: c.status,
        languages: c.languages || [],
        organisationName: c.organisationName || null,
        organisationType: c.organisationType || null,
        positionTitle: c.positionTitle || null,
        beatsProfessional: c.beatsProfessional || [],
        yearsExperience: c.yearsExperience || null,
        ethicsStrikes: c.ethicsStrikes || 0,
        journalistCharterAccepted: c.journalistCharterAccepted || false,
        charterAcceptedAt: c.charterAcceptedAt || null,
        storiesCount,
        verifiedBy: c.verifiedBy || null,
        verifiedAt: c.verifiedAt || null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }));

    return res.json({ ok: true, items: enriched, page, limit, total });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][journalist-applications] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});

// POST /admin/community/journalist-applications/:id/verify
router.post('/journalist-applications/:id/verify', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'verified';
    contact.status = 'active';
    contact.verifiedBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
    contact.verifiedAt = new Date();
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true, contact });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][verify] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to verify journalist' });
  }
});

// POST /admin/community/journalist-applications/:id/reject
router.post('/journalist-applications/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { reason } = req.body || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'revoked';
    if (reason) {
      contact.behaviourNotes = contact.behaviourNotes || [];
      contact.behaviourNotes.push({ note: String(reason), createdBy: (req.admin && (req.admin.email || req.admin.id)) || 'system' });
    }
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][reject] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to reject journalist' });
  }
});

// NEW: POST /admin/community/reporters/:id/status
router.post('/reporters/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { status, verificationLevel, addStrike, note } = req.body || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    const allowedStatus = ['active','watchlist','suspended','banned'];
    if (status) {
      if (!allowedStatus.includes(status)) return res.status(400).json({ ok: false, message: 'Invalid status' });
      contact.status = status;
    }
    const allowedVerif = ['community_default','pending','verified','limited','revoked'];
    if (verificationLevel) {
      if (!allowedVerif.includes(verificationLevel)) return res.status(400).json({ ok: false, message: 'Invalid verificationLevel' });
      contact.verificationLevel = verificationLevel;
    }
    if (addStrike === true) {
      contact.ethicsStrikes = (contact.ethicsStrikes || 0) + 1;
    }
    if (note) {
      contact.behaviourNotes = contact.behaviourNotes || [];
      contact.behaviourNotes.push({ note: String(note), createdBy: (req.admin && (req.admin.email || req.admin.id)) || 'system' });
    }
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true, contact });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][status] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to update reporter status' });
  }
});

module.exports = router;

// Detail view alias: GET /api/admin/community-reporter/submissions/:id
// Reuse the same response shape as legacy admin route
router.get('/submissions/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing submission id' });
    }
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) {
      return res.status(400).json({ success: false, message: 'Invalid submission id format' });
    }
    const submission = await CommunitySubmission.findById(id).lean();
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }
    return res.json({ success: true, submission });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][submission-detail] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

// POST /api/admin/community-reporter/submissions/:id/decision
// Accepts body { decision: 'approve'|'reject', rejectReason?, status? } and maps to internal status
router.post('/submissions/:id/decision', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Missing submission id' });
    }
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid submission id format' });
    }
    let submission;
    try {
      submission = await CommunitySubmission.findById(id);
    } catch (findErr) {
      console.error('[ADMIN_COMMUNITY][decision][find-error]', findErr?.message || findErr);
      return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load submission for decision', error: findErr?.message || String(findErr) });
    }
    if (!submission) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Submission not found' });
    }

    const prevStatus = submission.status;

    // Support multiple input keys: decision, status, action
    const decisionInput = (req.body && (req.body.decision || req.body.status || req.body.action)) || '';
    const decisionRaw = String(decisionInput).trim().toLowerCase();
    const rejectReason = (req.body && (req.body.rejectReason || req.body.reason)) || undefined;
    const hardDelete = Boolean(req.query.hard === '1' || req.query.hard === 'true' || req.body?.hard === true || req.body?.hardDelete === true);

    try {
      console.log('[ADMIN_COMMUNITY][decision] id=%s body=%j hard=%s by=%s', id, req.body || {}, hardDelete, (req.admin && (req.admin.email || req.admin.id)) || 'system');
    } catch (_) {}

    // Extended synonym lists
    const approveSet = new Set(['approve','approved','publish','published','ok']);
    const rejectSet = new Set(['reject','rejected','deny','denied','trash','delete','deleted','remove','discard']);

    if (approveSet.has(decisionRaw)) {
      submission.status = 'APPROVED';
      submission.rejectReason = undefined;
      // Create or update a draft News article linked to this submission
      let article = await upsertDraftFromSubmission(submission);
      if (article && article._id) {
        submission.linkedArticleId = article._id;
        try { submission.articleId = article._id; } catch (_) {}
      }
    } else if (rejectSet.has(decisionRaw)) {
      if (hardDelete === true) {
        try {
          const del = await CommunitySubmission.deleteOne({ _id: id });
          console.log('[ADMIN_COMMUNITY][decision][hard-delete] id=%s deleted=%j', id, del);
          return res.json({ ok: true, success: true, deleted: true, submissionId: id });
        } catch (delErr) {
          console.error('[ADMIN_COMMUNITY][decision][hard-delete][error]', delErr?.message || delErr);
          return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to hard delete submission' });
        }
      }
      submission.status = 'REJECTED';
      submission.rejectReason = rejectReason || 'Not specified';
    } else {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid decision' });
    }

    // Audit metadata if fields exist
    try {
      if ('decisionBy' in submission) {
        submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      }
      if ('decisionAt' in submission) {
        submission.decisionAt = new Date();
      }
      if ('updatedAt' in submission) {
        submission.updatedAt = new Date();
      }
    } catch (_) {}

    try {
      console.log('[ADMIN_COMMUNITY][decision][pre-save]', { id: submission._id.toString(), status: submission.status, rejectReason: submission.rejectReason });
      if (typeof submission.save === 'function') {
        await submission.save();
      }
      console.log('[ADMIN_COMMUNITY][decision][post-save]', { id: submission._id.toString(), status: submission.status, linkedArticleId: submission.linkedArticleId?.toString?.() });

      // Contributor network stats sync (best-effort)
      try {
        const {
          resolveAndAttachForSubmission,
          updateReporterProfileStatsForStatusChange,
        } = require('../services/reporterIdentityResolution.service');
        const link = await resolveAndAttachForSubmission(submission, { req });
        const profileId = submission.reporterProfileId || link?.profileId;
        if (profileId) {
          await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: submission.status });
        }
      } catch (_) {}
    } catch (saveErr) {
      console.error('[community decision][save-error]', saveErr?.message || saveErr);
      // Fallback for legacy docs failing validation: perform direct update without full validation
      try {
        const setObj = { status: submission.status };
        if (submission.status === 'REJECTED') {
          setObj.rejectReason = submission.rejectReason || 'Not specified';
        } else {
          setObj.rejectReason = undefined;
        }
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        if (submission.linkedArticleId) setObj.linkedArticleId = submission.linkedArticleId;
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[community decision][fallback-update]', upd);

        // Contributor network stats sync (best-effort)
        try {
          const {
            resolveAndAttachForSubmission,
            updateReporterProfileStatsForStatusChange,
          } = require('../services/reporterIdentityResolution.service');
          const link = await resolveAndAttachForSubmission(submission, { req });
          const profileId = submission.reporterProfileId || link?.profileId;
          if (profileId) {
            await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: setObj.status });
          }
        } catch (_) {}

        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh, articleId: submission.linkedArticleId || null });
      } catch (updErr) {
        console.error('[community decision][fallback-update-error]', updErr?.message || updErr);
        return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to apply decision', error: updErr?.message || String(updErr) });
      }
    }

    return res.json({ ok: true, success: true, submission, articleId: submission.linkedArticleId || null });
  } catch (err) {
    console.error('[community decision][unhandled]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to apply decision', error: err?.message || String(err) });
  }
});

// Explicit action endpoints used by some admin UI builds
router.post('/submissions/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Submission not found' });
    const prevStatus = submission.status;
    submission.status = 'APPROVED';
    submission.rejectReason = undefined;
    // Ensure a draft article exists/updated for this submission
    let article = await upsertDraftFromSubmission(submission);
    if (article && article._id) {
      submission.linkedArticleId = article._id;
      try { submission.articleId = article._id; } catch (_) {}
    }
    try {
      if ('decisionBy' in submission) submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      if ('decisionAt' in submission) submission.decisionAt = new Date();
      if ('updatedAt' in submission) submission.updatedAt = new Date();
    } catch (_) {}
    try {
      await submission.save();

      // Contributor network stats sync (best-effort)
      try {
        const {
          resolveAndAttachForSubmission,
          updateReporterProfileStatsForStatusChange,
        } = require('../services/reporterIdentityResolution.service');
        const link = await resolveAndAttachForSubmission(submission, { req });
        const profileId = submission.reporterProfileId || link?.profileId;
        if (profileId) {
          await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: 'APPROVED' });
        }
      } catch (_) {}

      return res.json({ ok: true, success: true, submission, articleId: submission.linkedArticleId || null });
    } catch (e) {
      // Fallback update without validation
      try {
        const setObj = { status: 'APPROVED', rejectReason: undefined };
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        if (submission.linkedArticleId) setObj.linkedArticleId = submission.linkedArticleId;
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[ADMIN_COMMUNITY][approve][fallback-update]', upd);

        // Contributor network stats sync (best-effort)
        try {
          const {
            resolveAndAttachForSubmission,
            updateReporterProfileStatsForStatusChange,
          } = require('../services/reporterIdentityResolution.service');
          const link = await resolveAndAttachForSubmission(submission, { req });
          const profileId = submission.reporterProfileId || link?.profileId;
          if (profileId) {
            await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: 'APPROVED' });
          }
        } catch (_) {}

        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh, articleId: submission.linkedArticleId || null });
      } catch (ue) {
        console.error('[ADMIN_COMMUNITY][approve][fallback-error]', ue?.message || ue);
        return res.status(500).json({ ok: false, success: false, message: 'Approve failed', error: ue?.message || String(ue) });
      }
    }
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][approve][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Approve failed' });
  }
});

router.post('/submissions/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const rejectReason = (req.body && (req.body.rejectReason || req.body.reason)) || 'Not specified';
    const hardDelete = Boolean(req.query.hard === '1' || req.query.hard === 'true' || req.body?.hard === true || req.body?.hardDelete === true);
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    if (hardDelete) {
      try {
        const del = await CommunitySubmission.deleteOne({ _id: id });
        console.log('[ADMIN_COMMUNITY][reject][hard-delete]', { id, del });
        return res.json({ ok: true, success: true, deleted: true, submissionId: id });
      } catch (delErr) {
        console.error('[ADMIN_COMMUNITY][reject][hard-delete][error]', delErr?.message || delErr);
        return res.status(500).json({ ok: false, success: false, message: 'Failed to hard delete' });
      }
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Submission not found' });
    const prevStatus = submission.status;
    submission.status = 'REJECTED';
    submission.rejectReason = rejectReason;
    try {
      if ('decisionBy' in submission) submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      if ('decisionAt' in submission) submission.decisionAt = new Date();
      if ('updatedAt' in submission) submission.updatedAt = new Date();
    } catch (_) {}
    try {
      await submission.save();

      // Contributor network stats sync (best-effort)
      try {
        const {
          resolveAndAttachForSubmission,
          updateReporterProfileStatsForStatusChange,
        } = require('../services/reporterIdentityResolution.service');
        const link = await resolveAndAttachForSubmission(submission, { req });
        const profileId = submission.reporterProfileId || link?.profileId;
        if (profileId) {
          await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: 'REJECTED' });
        }
      } catch (_) {}

      // Safety: ethics strike on reject when reporterId present
      try {
        const reason = rejectReason || submission.rejectReason || 'rejected';
        if (submission.reporterId) {
          await addStrikeForReporter(submission.reporterId.toString(), reason);
        }
      } catch (sErr) { console.warn('[ADMIN_COMMUNITY][reject][strike-failed]', sErr?.message || sErr); }
      return res.json({ ok: true, success: true, submission });
    } catch (e) {
      // Fallback update without validation
      try {
        const setObj = { status: 'REJECTED', rejectReason };
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[ADMIN_COMMUNITY][reject][fallback-update]', upd);

        // Contributor network stats sync (best-effort)
        try {
          const {
            resolveAndAttachForSubmission,
            updateReporterProfileStatsForStatusChange,
          } = require('../services/reporterIdentityResolution.service');
          const link = await resolveAndAttachForSubmission(submission, { req });
          const profileId = submission.reporterProfileId || link?.profileId;
          if (profileId) {
            await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: 'REJECTED' });
          }
        } catch (_) {}

        // Strike on fallback path too
        try {
          const reason = rejectReason || 'rejected';
          if (submission.reporterId) {
            await addStrikeForReporter(submission.reporterId.toString(), reason);
          }
        } catch (sErr) { console.warn('[ADMIN_COMMUNITY][reject][fallback-strike-failed]', sErr?.message || sErr); }
        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh });
      } catch (ue) {
        console.error('[ADMIN_COMMUNITY][reject][fallback-error]', ue?.message || ue);
        return res.status(500).json({ ok: false, success: false, message: 'Reject failed', error: ue?.message || String(ue) });
      }
    }
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][reject][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Reject failed' });
  }
});

// Restore a rejected submission back to pending review
// POST /api/admin/community-reporter/submissions/:id/restore
router.post('/submissions/:id/restore', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Submission not found' });
    const prevStatus = submission.status;
    submission.status = 'under_review';
    submission.rejectReason = undefined;
    try {
      if ('updatedAt' in submission) submission.updatedAt = new Date();
      await submission.save();

      // Contributor network stats sync (best-effort)
      try {
        const {
          resolveAndAttachForSubmission,
          updateReporterProfileStatsForStatusChange,
        } = require('../services/reporterIdentityResolution.service');
        const link = await resolveAndAttachForSubmission(submission, { req });
        const profileId = submission.reporterProfileId || link?.profileId;
        if (profileId) {
          await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: 'under_review' });
        }
      } catch (_) {}

      return res.json({ ok: true, success: true, submission });
    } catch (e) {
      // fallback
      try {
        const setObj = { status: 'under_review', rejectReason: undefined };
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[ADMIN_COMMUNITY][restore][fallback-update]', upd);

        // Contributor network stats sync (best-effort)
        try {
          const {
            resolveAndAttachForSubmission,
            updateReporterProfileStatsForStatusChange,
          } = require('../services/reporterIdentityResolution.service');
          const link = await resolveAndAttachForSubmission(submission, { req });
          const profileId = submission.reporterProfileId || link?.profileId;
          if (profileId) {
            await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: setObj.status });
          }
        } catch (_) {}

        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh });
      } catch (ue) {
        console.error('[ADMIN_COMMUNITY][restore][fallback-error]', ue?.message || ue);
        return res.status(500).json({ ok: false, success: false, message: 'Restore failed', error: ue?.message || String(ue) });
      }
    }
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][restore][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Restore failed' });
  }
});

// Permanent delete of a submission (from Rejected/Trash view)
// POST /api/admin/community-reporter/submissions/:id/delete
// Also support /hard-delete as alias
router.post('/submissions/:id/delete', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    const del = await CommunitySubmission.deleteOne({ _id: id });
    return res.json({ ok: true, success: true, deleted: del?.deletedCount === 1, submissionId: id });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][delete][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Delete failed' });
  }
});
router.post('/submissions/:id/hard-delete', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    const del = await CommunitySubmission.deleteOne({ _id: id });
    return res.json({ ok: true, success: true, deleted: del?.deletedCount === 1, submissionId: id });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][hard-delete][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Hard delete failed' });
  }
});

// Debug route to inspect raw document quickly (admin only)
router.get('/submissions/:id/debug', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid id' });
    }
    let doc;
    try { doc = await CommunitySubmission.findById(id).lean({ virtuals: true }); } catch (e) {
      console.error('[ADMIN_COMMUNITY][debug][find-error]', e?.message || e);
      return res.status(500).json({ ok: false, message: 'Find error', error: e?.message || String(e) });
    }
    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, doc });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][debug][unhandled]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Unhandled', error: e?.message || String(e) });
  }
});
