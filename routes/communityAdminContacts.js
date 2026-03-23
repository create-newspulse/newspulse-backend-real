const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { requireAdminAuth } = require('../middleware/adminAuth');

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
