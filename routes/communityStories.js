const express = require('express');
const mongoose = require('mongoose');
const News = require('../models/News');
const CommunitySubmission = require('../models/CommunitySubmission');
const {
  COMMUNITY_REPORTER_CATEGORIES,
  extractSubmissionAttachments,
  inferSubmissionDeskMetadata,
  normalizeCommunityReporterCategory,
  normalizeWorkflowStatus,
} = require('../services/communitySubmissionWorkflow');
let requireAdminAuth = (_req, _res, next) => next();
try { ({ requireAdminAuth } = require('../middleware/adminAuth')); } catch (_) {}

const router = express.Router();

// Determine if an article is community-origin
function isCommunityArticle(doc) {
  if (!doc) return false;
  if (doc.source === 'community') return true;
  if (doc.communityReportId) return true;
  return false;
}

// Build filter for "my" community stories belonging to current user.
// Since News doesn't store submittedBy, we derive via linked CommunitySubmission.
async function fetchSubmissionMap(ids) {
  if (!ids.length) return new Map();
  const subs = await CommunitySubmission.find({ _id: { $in: ids } }, 'reporterEmail reporterName email name city location state country').lean();
  const map = new Map();
  subs.forEach(s => map.set(String(s._id), s));
  return map;
}

// GET /api/community/stories/my
router.get('/stories/my', requireAdminAuth, async (req, res) => {
  try {
    // Toggle: My Stories portal availability
    try {
      const { getCommunitySettings } = require('../services/communitySettingsService');
      const settings = await getCommunitySettings();
      if (!settings.allowMyStoriesPortal) {
        return res.status(503).json({ ok: false, message: 'My Community Stories portal is currently unavailable.' });
      }
    } catch (_) {}
    // Auth user (admin/founder). For community ownership filtering we match submission reporterEmail if available.
    const currentEmail = req.admin?.email?.toLowerCase();

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;
    const statusParam = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();

    const baseFilter = { $or: [{ source: 'community' }, { communityReportId: { $exists: true } }] };
    if (statusParam && statusParam !== 'all') {
      baseFilter.status = statusParam;
    }
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      baseFilter.$and = [
        { $or: [ { title: regex }, { description: regex }, { content: regex } ] }
      ];
    }

    // Initial query (community-origin only)
    const query = News.find(baseFilter).sort({ createdAt: -1 });
    const total = await News.countDocuments(baseFilter);
    const articles = await query.skip(skip).limit(limit).lean();

    // Collect linked submission IDs
    const subIds = articles.filter(a => a.communityReportId).map(a => a.communityReportId);
    const subMap = await fetchSubmissionMap(subIds);

    // Ownership filter: include only those whose submission reporterEmail matches current user (if currentEmail present)
    const owned = currentEmail
      ? articles.filter(a => {
          if (!isCommunityArticle(a)) return false;
          if (a.communityReportId) {
            const sub = subMap.get(String(a.communityReportId));
            const email = (sub?.reporterEmail || sub?.email || '').toLowerCase();
            return email === currentEmail;
          }
          // No linked submission -> treat as not owned by reporter
          return false;
        })
      : articles;

    const items = owned.map(a => {
      const sub = a.communityReportId ? subMap.get(String(a.communityReportId)) : null;
      return {
        _id: a._id,
        title: a.title,
        summary: a.description,
        content: a.content,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        language: a.language,
        category: a.category,
        location: sub?.locationDetail?.city || sub?.city || sub?.location || null,
        city: sub?.locationDetail?.city || sub?.city || null,
        locationDetail: sub?.locationDetail || null,
        source: a.source || null,
        submittedBy: (sub?.reporterEmail || sub?.email || null),
        contact: sub?.contact ? {
          name: sub.contact.name || null,
          email: sub.contact.email || null,
          phone: sub.contact.phone || null,
          preferredContact: sub.contact.preferredContact || 'no_preference',
        } : null,
      };
    });

    return res.json({ ok: true, items, total: owned.length, page, limit });
  } catch (e) {
    console.error('[COMMUNITY_STORIES][my-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load stories' });
  }
});

// POST /api/community/stories/:id/withdraw (optional)
router.post('/stories/:id/withdraw', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'invalid id' });
    }
    const doc = await News.findById(id);
    if (!doc || !isCommunityArticle(doc)) {
      return res.status(404).json({ ok: false, message: 'Article not found' });
    }

    // Ownership enforcement if submission exists
    const currentEmail = req.admin?.email?.toLowerCase();
    if (doc.communityReportId && currentEmail) {
      const sub = await CommunitySubmission.findById(doc.communityReportId, 'reporterEmail email').lean();
      const email = (sub?.reporterEmail || sub?.email || '').toLowerCase();
      if (email && email !== currentEmail) {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
    }

    // Allowed statuses to withdraw: draft, scheduled (return to archived)
    if (!['draft','scheduled','published'].includes(doc.status)) {
      // Already archived/deleted; treat as idempotent success
      return res.json({ ok: true, article: doc });
    }
    doc.status = 'archived'; // Using archived as withdrawn marker (schema enum safe)
    await doc.save();
    try {
      const ActivityLog = require('../models/ActivityLog');
      await ActivityLog.create({ type: 'community_withdraw', email: req.admin?.email || 'admin', meta: { articleId: doc._id.toString() } });
    } catch (_) {}
    return res.json({ ok: true, article: doc });
  } catch (e) {
    console.error('[COMMUNITY_STORIES][withdraw-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to withdraw story' });
  }
});

module.exports = router;

// --- Submit a community/journalist story ---
// POST /api/community/stories/submit
router.post('/stories/submit', async (req, res) => {
  try {
    // Enforce global toggles on submissions
    try {
      const { getCommunitySettings } = require('../services/communitySettingsService');
      const settings = await getCommunitySettings();
      if (!settings.communityReporterEnabled || !settings.allowNewSubmissions) {
        return res.status(503).json({ ok: false, code: 'COMMUNITY_CLOSED', message: 'Community Reporter submissions are currently closed.' });
      }
    } catch (_) {}
    const body = req.body || {};
    const deskMeta = inferSubmissionDeskMetadata(body);
    const {
      reporterName,
      name,
      fullName,
      email,
      headline,
      story,
      category,
      city,
      state,
      country,
      location,
      track,
      isProfessionalJournalist,
      preferredLanguages,
      organisationName,
      organisationType,
      positionTitle,
      yearsExperience,
      websiteOrPortfolio,
      socialLinks,
      journalistCharterAccepted,
    } = body;

    const normalizedName = (reporterName || fullName || name || '').trim();
    const normalizedEmail = (email || '').trim().toLowerCase();
    const normalizedCity = (city || location || '').trim();
    const normalizedState = (state || '').trim();
    const normalizedCountry = (country || '').trim();
    const normalizedCategory = normalizeCommunityReporterCategory(category || track || null);

    if (!normalizedName || !normalizedEmail || !headline || !story || !normalizedCategory) {
      const message = normalizedCategory
        ? 'Missing required fields'
        : `Category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`;
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message });
    }

    // Upsert reporter contact to determine reporterType
    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    let reporterContact = null;
    try {
      const reporterType = isProfessionalJournalist ? 'journalist' : 'community';
      const result = await upsertReporterContactFromPayload({
        name: normalizedName,
        email: normalizedEmail,
        city: normalizedCity,
        state: normalizedState,
        country: normalizedCountry,
        reporterType,
        languages: Array.isArray(preferredLanguages) ? preferredLanguages : undefined,
        organisationName,
        organisationType,
        positionTitle,
        yearsExperience,
        websiteOrPortfolio,
        socialLinks,
        journalistCharterAccepted,
      });
      reporterContact = result && result.contact ? result.contact : null;
    } catch (e) {
      // continue without reporterContact
    }

    if (!reporterContact) {
      return res.status(400).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter profile not found' });
    }

    const initialStatus = await (async () => {
      try {
        const { getCommunitySettings } = require('../services/communitySettingsService');
        const s = await getCommunitySettings();
        if (deskMeta.isYouthPulse) return 'NEW';
        return s.safeModeManualReviewOnly ? 'pending' : 'UNDER_REVIEW';
      } catch (_) {
        return deskMeta.isYouthPulse ? 'NEW' : 'UNDER_REVIEW';
      }
    })();

    const attachments = extractSubmissionAttachments(body);

    // Create submission document; force pending in safe mode
    const submission = await CommunitySubmission.create({
      reporterName: normalizedName,
      reporterEmail: normalizedEmail,
      name: normalizedName,
      email: normalizedEmail,
      category: normalizedCategory,
      desk: deskMeta.desk || undefined,
      submissionType: deskMeta.submissionType || undefined,
      intakeSource: deskMeta.intakeSource || undefined,
      track: deskMeta.track || undefined,
      headline: (headline || '').trim(),
      body: (story || '').trim(),
      location: { city: normalizedCity || null, state: normalizedState || null, country: normalizedCountry || null },
      city: normalizedCity || undefined,
      state: normalizedState || undefined,
      country: normalizedCountry || undefined,
      contact: {
        name: normalizedName,
        email: normalizedEmail,
        phone: (body.phone || body.contactPhone || '').trim() || undefined,
      },
      attachments,
      mediaUrl: (attachments[0] && attachments[0].url) || undefined,
      mediaLink: (attachments[0] && attachments[0].url) || undefined,
      reporterId: reporterContact && reporterContact._id ? reporterContact._id : undefined,
      sourceType: reporterContact && reporterContact.reporterType === 'journalist' ? 'journalist' : 'community',
      status: deskMeta.isYouthPulse ? normalizeWorkflowStatus(initialStatus, 'NEW') : initialStatus,
    });

    // Contributor network linkage (best-effort; never blocks submission)
    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    const referenceId = submission.referenceId || submission.publicId || submission._id.toString();
    const reporterType = reporterContact && reporterContact.reporterType === 'journalist' ? 'journalist' : 'community';
    const reporterNameOut = normalizedName || undefined;

    return res.status(201).json({
      ok: true,
      message: 'Story submitted successfully.',
      storyId: submission._id.toString(),
      referenceId,
      status: String(submission.status || 'under_review').toLowerCase(),
      reporterType,
      reporterName: reporterNameOut,
      desk: submission.desk || null,
      track: submission.track || null,
    });
  } catch (e) {
    console.error('[COMMUNITY_STORY_SUBMIT][error]', e?.message || e);
    return res.status(500).json({ ok: false, code: 'COMMUNITY_STORY_SUBMIT_FAILED', message: 'Something went wrong while submitting story.' });
  }
});