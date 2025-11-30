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
    const skip = (page - 1) * limit;
    const { source, status = 'pending', q } = req.query || {};

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

    // Status mapping: support legacy lowercase and new uppercase/workflow statuses
    // Pending Review tab → all "not-final" submissions
    if (status === 'pending') {
      filter.status = { $in: ['pending', 'PENDING_FOUNDER', 'under_review'] };
    } else if (status === 'rejected') {
      filter.status = { $in: ['rejected', 'REJECTED'] };
    } else if (status === 'approved') {
      filter.status = { $in: ['approved', 'APPROVED'] };
    } // else 'all' or anything else → no status filter

    // Optional simple text search on headline or location
    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = (filter.$or || []).concat([
        { headline: regex },
        { location: regex },
      ]);
    }

    const query = CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const [items, total] = await Promise.all([
      query.lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const mapped = items.map(s => ({
      id: s._id.toString(),
      headline: s.headline,
      story: s.body,
      category: s.category,
      location: s.location || (s.locationDetail && s.locationDetail.city) || null,
      status: s.status,
      sourceType: s.sourceType || 'community', // compatibility default
      reporterVerificationLevel: s.reporterVerificationLevel || 'community_default',
      reporterId: s.reporterId || null,
      reporterName: s.reporterName || s.name || (s.contact && s.contact.name) || null,
      reporterEmail: s.reporterEmail || s.email || (s.contact && s.contact.email) || null,
      riskScore: s.riskScore || 0,
      flags: s.flags || [],
      createdAt: s.createdAt,
    }));

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
