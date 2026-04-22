const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const YouthPulseContributor = require('../models/YouthPulseContributor');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { getCommunityReporterSettings, updateCommunityReporterSettings } = require('../newspulse-backend-real-main/controllers/communityReporterSettingsController');
const { adminListReporterContacts } = require('../controllers/communityReporterController');
const {
  buildYouthPulseAdminFilter,
  createYouthPulseDraft,
  getYouthPulseSubmissionById,
  normalizeYouthPulseStatus,
  sanitizeText,
  toYouthPulseAdminDto,
} = require('../services/youthPulseSubmission.service');
const { normalizeTrackValue } = require('../services/communitySubmissionWorkflow');
const {
  buildYouthPulseContributorFilter,
  syncYouthPulseContributorStats,
  toYouthPulseContributorDto,
} = require('../services/youthPulseContributor.service');
const router = express.Router();

async function loadYouthPulseSubmission(req, res) {
  const submission = await getYouthPulseSubmissionById(req.params.id);
  if (!submission) {
    res.status(404).json({ ok: false, success: false, message: 'Youth Pulse submission not found' });
    return null;
  }
  return submission;
}

function adminActor(req) {
  return req.admin?.email || req.admin?.id || 'admin';
}

router.get('/youth-pulse/submissions', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const filter = buildYouthPulseAdminFilter(req.query || {});

    const [items, total] = await Promise.all([
      YouthPulseSubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      YouthPulseSubmission.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      ok: true,
      submissions: items.map((item) => toYouthPulseAdminDto(item)),
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][list-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Youth Pulse submissions' });
  }
});

router.get('/youth-pulse/submissions/:id', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;
    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][detail-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Youth Pulse submission' });
  }
});

router.patch('/youth-pulse/submissions/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    const status = normalizeYouthPulseStatus(req.body?.status, null);
    if (!status || !['new', 'under_review', 'approved', 'rejected', 'draft_created', 'published'].includes(status)) {
      return res.status(400).json({ ok: false, success: false, message: 'status must be one of new, under_review, approved, rejected, draft_created, published' });
    }

    submission.status = status;
    submission.reviewedBy = adminActor(req);
    if (req.body?.moderationFlags !== undefined) {
      submission.moderationFlags = Array.isArray(req.body.moderationFlags)
        ? req.body.moderationFlags.map((entry) => sanitizeText(entry, { maxLength: 80, allowNewlines: false })).filter(Boolean)
        : [];
    }
    if (req.body?.riskLevel !== undefined) {
      submission.riskLevel = sanitizeText(req.body.riskLevel, { maxLength: 24, allowNewlines: false }).toLowerCase() || null;
    }
    if (req.body?.verificationNotes !== undefined) {
      submission.verificationNotes = sanitizeText(req.body.verificationNotes, { maxLength: 4000, allowNewlines: true }) || null;
    }
    if (req.body?.editorialNotes !== undefined) {
      submission.editorialNotes = sanitizeText(req.body.editorialNotes, { maxLength: 4000, allowNewlines: true }) || null;
    }

    if (status === 'approved') {
      submission.approvedBy = adminActor(req);
      submission.rejectionReason = null;
    }
    if (status === 'rejected') {
      const reason = sanitizeText(req.body?.rejectionReason || req.body?.reason, { maxLength: 500, allowNewlines: true });
      if (!reason) {
        return res.status(400).json({ ok: false, success: false, message: 'rejectionReason is required when rejecting' });
      }
      submission.rejectionReason = reason;
    }

    await submission.save();
    if (submission.contributorId) {
      await syncYouthPulseContributorStats(submission.contributorId).catch(() => null);
    }
    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][status-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update Youth Pulse moderation status' });
  }
});

router.patch('/youth-pulse/submissions/:id/editorial', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    if (req.body?.verificationNotes !== undefined) {
      submission.verificationNotes = sanitizeText(req.body.verificationNotes, { maxLength: 4000, allowNewlines: true }) || null;
    }
    if (req.body?.editorialNotes !== undefined) {
      submission.editorialNotes = sanitizeText(req.body.editorialNotes, { maxLength: 4000, allowNewlines: true }) || null;
    }
    if (req.body?.moderationFlags !== undefined) {
      submission.moderationFlags = Array.isArray(req.body.moderationFlags)
        ? req.body.moderationFlags.map((entry) => sanitizeText(entry, { maxLength: 80, allowNewlines: false })).filter(Boolean)
        : [];
    }
    if (req.body?.riskLevel !== undefined) {
      submission.riskLevel = sanitizeText(req.body.riskLevel, { maxLength: 24, allowNewlines: false }).toLowerCase() || null;
    }

    submission.reviewedBy = adminActor(req);
    await submission.save();
    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][editorial-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to save Youth Pulse editorial fields' });
  }
});

router.patch('/youth-pulse/submissions/:id/track', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    const track = normalizeTrackValue(req.body?.track);
    if (!track) {
      return res.status(400).json({ ok: false, success: false, message: 'A valid Youth Pulse track is required' });
    }

    submission.track = track;
    submission.reviewedBy = adminActor(req);
    await submission.save();

    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][track-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update Youth Pulse track' });
  }
});

router.post('/youth-pulse/submissions/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    submission.status = 'approved';
    submission.reviewedBy = adminActor(req);
    submission.approvedBy = adminActor(req);
    submission.rejectionReason = null;
    if (req.body?.track) {
      const track = normalizeTrackValue(req.body.track);
      if (!track) {
        return res.status(400).json({ ok: false, success: false, message: 'A valid Youth Pulse track is required' });
      }
      submission.track = track;
    }
    await submission.save();
    if (submission.contributorId) {
      await syncYouthPulseContributorStats(submission.contributorId).catch(() => null);
    }

    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][approve-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to approve Youth Pulse submission' });
  }
});

router.post('/youth-pulse/submissions/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    const reason = sanitizeText(req.body?.rejectionReason || req.body?.reason, { maxLength: 500, allowNewlines: true });
    if (!reason) {
      return res.status(400).json({ ok: false, success: false, message: 'rejectionReason is required' });
    }

    submission.status = 'rejected';
    submission.reviewedBy = adminActor(req);
    submission.rejectionReason = reason;
    await submission.save();
    if (submission.contributorId) {
      await syncYouthPulseContributorStats(submission.contributorId).catch(() => null);
    }

    return res.json({ success: true, ok: true, submission: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][reject-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to reject Youth Pulse submission' });
  }
});

async function createYouthPulseDraftHandler(req, res) {
  try {
    const submission = await loadYouthPulseSubmission(req, res);
    if (!submission) return;

    if (!['approved', 'draft_created', 'published'].includes(normalizeYouthPulseStatus(submission.status, 'new'))) {
      return res.status(409).json({ ok: false, success: false, message: 'Submission must be approved before creating a draft' });
    }

    if (req.body?.track) {
      const track = normalizeTrackValue(req.body.track);
      if (!track) {
        return res.status(400).json({ ok: false, success: false, message: 'A valid Youth Pulse track is required' });
      }
      submission.track = track;
    }

    const { submission: draftedSubmission, article } = await createYouthPulseDraft(submission, { admin: adminActor(req) });
    return res.json({
      success: true,
      ok: true,
      handoff: 'draft_created',
      submission: toYouthPulseAdminDto(draftedSubmission.toObject ? draftedSubmission.toObject() : draftedSubmission),
      article: article
        ? {
            id: String(article._id),
            slug: article.slug || null,
            status: article.status || null,
            publishedAt: article.publishedAt || null,
          }
        : null,
    });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][create-draft-error]', err?.message || err);
    const statusCode = err?.statusCode || 500;
    return res.status(statusCode).json({ ok: false, success: false, message: err?.message || 'Failed to create Youth Pulse draft' });
  }
}

router.post('/youth-pulse/submissions/:id/create-draft', requireAdminAuth, createYouthPulseDraftHandler);
router.post('/youth-pulse/submissions/:id/publish', requireAdminAuth, createYouthPulseDraftHandler);

router.get('/youth-pulse/contributors', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const filter = buildYouthPulseContributorFilter(req.query || {});

    const [items, total] = await Promise.all([
      YouthPulseContributor.find(filter).sort({ lastSubmissionAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      YouthPulseContributor.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      ok: true,
      contributors: items.map((item) => toYouthPulseContributorDto(item)),
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][contributors-list-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Youth Pulse contributors' });
  }
});

router.get('/youth-pulse/contributors/:id', requireAdminAuth, async (req, res) => {
  try {
    const contributor = await YouthPulseContributor.findById(req.params.id).lean();
    if (!contributor) {
      return res.status(404).json({ ok: false, success: false, message: 'Youth Pulse contributor not found' });
    }
    return res.json({ success: true, ok: true, contributor: toYouthPulseContributorDto(contributor) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][contributors-detail-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load Youth Pulse contributor' });
  }
});

router.patch('/youth-pulse/contributors/:id', requireAdminAuth, async (req, res) => {
  try {
    const contributor = await YouthPulseContributor.findById(req.params.id);
    if (!contributor) {
      return res.status(404).json({ ok: false, success: false, message: 'Youth Pulse contributor not found' });
    }

    if (req.body?.notes !== undefined) {
      contributor.notes = sanitizeText(req.body.notes, { maxLength: 4000, allowNewlines: true }) || null;
    }
    if (req.body?.status !== undefined) {
      const status = sanitizeText(req.body.status, { maxLength: 24, allowNewlines: false });
      if (!['active', 'blocked', 'trusted'].includes(status)) {
        return res.status(400).json({ ok: false, success: false, message: 'status must be one of active, blocked, trusted' });
      }
      contributor.status = status;
    }

    await contributor.save();
    await syncYouthPulseContributorStats(contributor._id).catch(() => null);
    return res.json({ success: true, ok: true, contributor: toYouthPulseContributorDto(contributor.toObject ? contributor.toObject() : contributor) });
  } catch (err) {
    console.error('[ADMIN_YOUTH_PULSE][contributors-update-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update Youth Pulse contributor' });
  }
});

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
