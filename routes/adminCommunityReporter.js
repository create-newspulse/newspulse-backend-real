const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// Placeholder admin community-reporter routes to ensure server boots.
// Keep responses minimal; real implementations can extend these.
router.get('/submissions', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    return res.json({ ok: true, items: [], total: 0, page, limit });
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
