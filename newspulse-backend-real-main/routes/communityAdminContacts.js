const express = require('express');
// Use middleware from root workspace (one level above nested project)
const { requireAdminAuth } = require('../../middleware/adminAuth');

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
