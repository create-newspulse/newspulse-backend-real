const express = require('express');
// Use middleware from root workspace (one level above nested project)
const { requireAdminAuth } = require('../../middleware/adminAuth');
const {
  safeDecodeURIComponent,
  normalizeEmail,
  findReporterContactByIdentifier,
  deriveReporterStatsFromSubmissionsByEmail,
} = require('../../services/reporterLookup.service');

// Unified reporter-centric directory (ReporterProfile-based) lives in the root app.
const { getReporterDirectory } = require('../../controllers/adminContributorNetworkController');

const router = express.Router();

// Admin reporter contacts (stub/minimal) - mirrors root implementation placeholder
router.get('/reporter-contacts', requireAdminAuth, async (req, res) => {
  try {
    // For now return empty list; real aggregation lives in root app.
    return res.json({
      ok: true,
      success: true,
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    });
  } catch (err) {
    console.error('[nested][reporter-contacts] error', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load community contacts' });
  }
});

// List stories for a single reporter (stub)
router.get('/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKey = String(req.query.reporterKey || '').trim();
    if (!reporterKey) {
      return res.status(400).json({ ok: false, message: 'Missing reporterKey' });
    }
    return res.json({ ok: true, items: [], total: 0 });
  } catch (err) {
    console.error('[nested][reporter-stories] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

// GET /api/admin/community/reporter-directory/lookup?identifier=EMAIL_OR_ID
// This router is mounted by the top-level server under /api/admin/community.
router.get('/reporter-directory/lookup', requireAdminAuth, async (req, res) => {
  const debug = process.env.COMMUNITY_REPORTER_DEBUG_LOOKUP === '1';
  try {
    const raw = (req.query && (req.query.identifier || req.query.email || req.query.q)) || '';
    const decoded = String(safeDecodeURIComponent(raw) || '').trim();
    if (!decoded) {
      return res.status(400).json({ ok: false, message: 'identifier (email or id) is required' });
    }

    const lookup = await findReporterContactByIdentifier(decoded);
    const contact = lookup.contact ? (typeof lookup.contact.toObject === 'function' ? lookup.contact.toObject() : lookup.contact) : null;

    const emailFromContact = contact && contact.email ? normalizeEmail(contact.email) : null;
    const emailFromIdentifier = decoded.includes('@') ? normalizeEmail(decoded) : null;
    const emailForStats = emailFromContact || emailFromIdentifier;
    const derived = emailForStats ? await deriveReporterStatsFromSubmissionsByEmail(emailForStats) : null;

    const emptyStats = {
      totalStories: 0,
      approvedStories: 0,
      pendingStories: 0,
      rejectedStories: 0,
      withdrawnStories: 0,
      publishedStories: 0,
      lastStoryAt: null,
      lastStoryTitle: null,
    };

    const reporter = {
      id: contact && contact._id ? String(contact._id) : null,
      name: (contact && contact.fullName) ? String(contact.fullName) : (derived && derived.name ? String(derived.name) : null),
      email: emailForStats || (contact && contact.email ? String(contact.email) : null),
      phone: (contact && (contact.phoneFull || contact.phoneNumber)) ? String(contact.phoneFull || contact.phoneNumber) : null,
      city: contact && contact.cityTownVillage ? String(contact.cityTownVillage) : null,
      district: contact && contact.districtName ? String(contact.districtName) : null,
      state: contact && contact.stateName ? String(contact.stateName) : null,
      country: contact && contact.country ? String(contact.country) : null,
      reporterType: contact && contact.reporterType ? String(contact.reporterType) : null,
      verificationLevel: contact && contact.verificationLevel ? String(contact.verificationLevel) : null,
      status: contact && contact.status ? String(contact.status) : null,
    };

    const stats = (derived && derived.stats) ? derived.stats : (contact && contact.stats ? contact.stats : emptyStats);

    if (debug) {
      console.log('[nested][admin][reporter-directory][lookup]', {
        identifier: decoded,
        kind: lookup.kind,
        contactId: reporter.id,
        emailForStats,
        totalStories: Number(stats && stats.totalStories || 0),
      });
    }

    return res.status(200).json({
      ok: true,
      identifier: decoded,
      kind: lookup.kind,
      reporter,
      stats: {
        ...emptyStats,
        ...stats,
        totalStories: Number(stats && stats.totalStories || 0),
        approvedStories: Number(stats && stats.approvedStories || 0),
        pendingStories: Number(stats && stats.pendingStories || 0),
        rejectedStories: Number(stats && stats.rejectedStories || 0),
        withdrawnStories: Number(stats && stats.withdrawnStories || 0),
        publishedStories: Number(stats && stats.publishedStories || 0),
        lastStoryAt: (stats && stats.lastStoryAt) || null,
        lastStoryTitle: (stats && stats.lastStoryTitle) || null,
      },
      derivedFrom: contact ? 'contact' : (derived ? 'submissions' : 'none'),
    });
  } catch (err) {
    console.error('[nested][admin][reporter-directory][lookup] error', err?.stack || err);
    return res.status(500).json({ ok: false, message: 'Lookup failed' });
  }
});

// GET /api/admin/community/reporter-directory/unified
// Returns a unified reporter-centric dataset (one-person-one-profile) with story counts + activity summaries.
router.get('/reporter-directory/unified', requireAdminAuth, getReporterDirectory);

module.exports = router;

// --- Admin alias: Journalist Applications listing under /admin/community ---
// The admin panel calls GET /admin/community/journalist-applications
// Provide a handler here (delegates to root models) so nested deployment also serves it.
const ReporterContact = require('../../models/ReporterContact');
const CommunitySubmission = require('../../models/CommunitySubmission');

async function handleJournalistApplications(req, res) {
  try {
    const { status = 'all' } = req.query || {};
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    const filter = { reporterType: 'journalist' };
    if (status === 'pending') filter.verificationLevel = 'pending';
    else if (status === 'verified') filter.verificationLevel = 'verified';
    else filter.verificationLevel = { $in: ['pending', 'verified'] };

    const [items, total] = await Promise.all([
      ReporterContact.find(filter).sort({ verifiedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    const enriched = await Promise.all(items.map(async (c) => {
      let storyCount = 0;
      try { storyCount = await CommunitySubmission.countDocuments({ reporterId: c._id }); } catch (_) {}
      return {
        _id: c._id,
        id: String(c._id),
        name: c.fullName || null,
        email: c.email || null,
        phone: c.phoneFull || null,
        city: c.cityTownVillage || null,
        state: c.stateName || null,
        country: c.country || null,
        reporterType: c.reporterType,
        verificationLevel: c.verificationLevel,
        organisationName: c.organisationName || null,
        organisationType: c.organisationType || null,
        positionTitle: c.positionTitle || null,
        beatsProfessional: c.beatsProfessional || [],
        yearsExperience: c.yearsExperience || null,
        languages: c.languages || [],
        websiteOrPortfolio: c.websiteOrPortfolio || null,
        socialLinks: c.socialLinks || {},
        verifiedBy: c.verifiedBy || null,
        verifiedAt: c.verifiedAt || null,
        storyCount,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }));

    return res.json({ ok: true, items: enriched, page, limit, total });
  } catch (err) {
    console.error('[nested][journalist-applications] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
}

// Primary path expected by admin panel
router.get('/journalist-applications', requireAdminAuth, handleJournalistApplications);
