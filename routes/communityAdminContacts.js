const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  safeDecodeURIComponent,
  normalizeEmail,
  findReporterContactByIdentifier,
  deriveReporterStatsFromSubmissionsByEmail,
} = require('../services/reporterLookup.service');
const {
  adminListReporterContacts,
  getReporterContactDetail,
  adminListReporterContactStories,
  listHiddenReporterContacts,
} = require('../controllers/communityReporterController');

// Unified reporter-centric directory (ReporterProfile-based)
const { getReporterDirectory } = require('../controllers/adminContributorNetworkController');

const router = express.Router();

// GET /api/admin/community/reporter-directory
// Query params supported:
// search, state, district, taluka, areaType, beat, status, page, limit
router.get('/reporter-directory', requireAdminAuth, async (req, res) => {
  try {
    const {
      search = '',
      state = '',
      district = '',
      taluka = '',
      areaType = '',
      beat = '',
      status = '',
    } = req.query || {};

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = {};

    // Free text search: fullName, email, phoneFull, cityTownVillage
    if (search && String(search).trim() !== '') {
      const rx = new RegExp(String(search).trim(), 'i');
      q.$or = [
        { fullName: rx },
        { email: rx },
        { phoneFull: rx },
        { cityTownVillage: rx },
      ];
    }

    if (state && String(state).trim() !== '') {
      const rx = new RegExp(String(state).trim(), 'i');
      q.$or = (q.$or || []).concat([
        { stateName: rx },
        { stateCode: rx },
      ]);
    }

    if (district && String(district).trim() !== '') {
      q.districtName = new RegExp(String(district).trim(), 'i');
    }

    if (taluka && String(taluka).trim() !== '') {
      q.talukaName = new RegExp(String(taluka).trim(), 'i');
    }

    if (areaType && String(areaType).trim() !== '') {
      q.areaType = String(areaType).trim().toUpperCase();
    }

    if (beat && String(beat).trim() !== '') {
      // beats is an array of enum strings
      q.beats = String(beat).trim().toUpperCase();
    }

    if (status && String(status).trim() !== '') {
      q.status = String(status).trim().toUpperCase();
    }

    const sort = { 'stats.lastStoryAt': -1, fullName: 1 };

    const [items, total] = await Promise.all([
      ReporterContact.find(q).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(q),
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));

    return res.json({ ok: true, items, total, page, pages });
  } catch (err) {
    console.error('[ReporterDirectory] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
});

// GET /api/admin/community/reporter-directory/unified
// ReporterProfile-powered directory (supports missing email/phone/location).
// Response shape matches the admin Reporter Contact Directory needs.
router.get('/reporter-directory/unified', requireAdminAuth, getReporterDirectory);

// Backward-compatible alias used by some admin panel builds.
// Canonical route remains /api/admin/community/reporter-directory/unified.
router.get('/contributors', requireAdminAuth, getReporterDirectory);

// Deprecated compatibility aliases for older admin builds.
// Canonical family remains /api/admin/community-reporter/contacts/*.
router.get('/reporter-contacts', requireAdminAuth, adminListReporterContacts);
router.get('/reporter-contacts/removed', requireAdminAuth, listHiddenReporterContacts);
router.get('/reporter-contacts/:id', requireAdminAuth, getReporterContactDetail);
router.get('/reporter-contacts/:id/stories', requireAdminAuth, adminListReporterContactStories);
router.get('/contributors/:id', requireAdminAuth, getReporterContactDetail);
router.get('/contributors/:id/stories', requireAdminAuth, adminListReporterContactStories);
router.get('/reporters/:id', requireAdminAuth, getReporterContactDetail);
router.get('/reporters/:id/stories', requireAdminAuth, adminListReporterContactStories);

// GET /api/admin/community/reporter-directory/lookup?identifier=EMAIL_OR_ID
// - Accepts email (URL-encoded) or a Mongo ObjectId
// - Never throws on invalid ObjectId (no CastError)
// - Always returns a stable response shape; derives stats from submissions when contact is missing
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
      console.log('[ADMIN][reporter-directory][lookup]', {
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
    console.error('[ADMIN][reporter-directory][lookup] error', err?.stack || err);
    return res.status(500).json({ ok: false, message: 'Lookup failed' });
  }
});


module.exports = router;

// --- Admin alias: Journalist Applications listing under /admin/community ---
// The admin panel calls GET /admin/community/journalist-applications
// Provide the handler here using the same logic as journalist listing.
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

    // storyCount enrichment (optional)
    const CommunitySubmission = require('../models/CommunitySubmission');
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
    console.error('[ADMIN_COMMUNITY][journalist-applications] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
}

// Primary path expected by admin panel
router.get('/journalist-applications', requireAdminAuth, handleJournalistApplications);
// Common variants (pluralization and nested path)
router.get('/journalists-applications', requireAdminAuth, handleJournalistApplications);
router.get('/journalists/applications', requireAdminAuth, handleJournalistApplications);
