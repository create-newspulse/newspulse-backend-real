const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { getCommunityReporterSettings, updateCommunityReporterSettings } = require('../controllers/communityReporterSettingsController');
const { adminListReporterContacts } = require('../controllers/communityReporterController');
const router = express.Router();

// TODO: protect with admin auth again before production
// GET /api/admin/community/submissions (admin queue listing)
router.get('/submissions', async (req, res) => {
  try {
    const { category } = req.query || {};
    // Map external status values to internal stored statuses; default to pending group.
    const rawStatus = (req.query.status || 'pending').toString().toLowerCase();
    let statusFilter;
    if (rawStatus === 'pending') {
      statusFilter = { $in: ['pending', 'PENDING_FOUNDER', 'under_review'] };
    } else if (rawStatus === 'rejected') {
      statusFilter = { $in: ['rejected', 'REJECTED'] };
    } else if (rawStatus === 'approved') {
      statusFilter = { $in: ['approved', 'APPROVED'] };
    } else if (rawStatus === 'all') {
      statusFilter = undefined; // leave unfiltered
    } else if (typeof rawStatus === 'string' && rawStatus.includes(',')) {
      const parts = rawStatus.split(',').map(s => s.trim()).filter(Boolean);
      statusFilter = parts.length ? { $in: parts } : { $in: ['pending', 'PENDING_FOUNDER', 'under_review'] };
    } else {
      statusFilter = rawStatus; // direct equality fallback
    }
    const filter = {};
    if (statusFilter !== undefined) {
      filter.status = statusFilter;
    }

    if (category && category !== 'all') {
      filter.category = String(category).trim();
    }

    const submissions = await CommunitySubmission
      .find(filter, '_id name email location category headline status aiHeadline aiBody riskScore flags createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();
    console.log('[ADMIN_COMMUNITY_API][list] rawStatus=%s applied=%j count=%d', rawStatus, statusFilter, submissions.length);
    return res.json({ success: true, submissions });
  } catch (e) {
    console.error('[Admin] Failed to load community submissions', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load community submissions' });
  }
});
router.patch('/submissions/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectReason } = req.body || {};
    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'Status must be APPROVED or REJECTED' });
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Not found' });
    const prevStatus = submission.status;
    if (status === 'APPROVED') {
      submission.status = 'APPROVED';
      submission.rejectReason = undefined;
    } else if (status === 'REJECTED') {
      submission.status = 'REJECTED';
      submission.rejectReason = rejectReason || 'Not specified';
    }
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
        await updateReporterProfileStatsForStatusChange({ profileId, fromStatus: prevStatus, toStatus: submission.status });
      }
    } catch (_) {}

    return res.json({ ok: true, submission: {
      _id: submission._id,
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      status: submission.status,
      rejectReason: submission.rejectReason,
      updatedAt: submission.updatedAt,
    }});
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][status-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to update status' });
  }
});

// GET /api/admin/community/submissions/:id (detail view)
router.get('/submissions/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing submission id' });
    }
    // Optional ObjectId shape validation (24 hex chars)
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
    console.error('[Admin] Error loading community submission by id', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

module.exports = router;

// Settings: Community Reporter portal enable/disable
router.get('/settings/community-reporter', requireAdminAuth, getCommunityReporterSettings);
router.put('/settings/community-reporter', requireAdminAuth, updateCommunityReporterSettings);

// GET /api/admin/community/reporter-contacts
router.get('/reporter-contacts', requireAdminAuth, adminListReporterContacts);
