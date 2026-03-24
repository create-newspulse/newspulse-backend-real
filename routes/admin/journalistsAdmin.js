const express = require('express');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const ReporterContact = require('../../models/ReporterContact');
const CommunitySubmission = require('../../models/CommunitySubmission');
const { findReporterContactByIdentifier } = require('../../services/reporterLookup.service');

const router = express.Router();

// GET /api/admin/journalists/applications
router.get('/journalists/applications', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    const filter = { reporterType: 'journalist', verificationLevel: 'pending' };

    const [contacts, total] = await Promise.all([
      ReporterContact.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    const items = await Promise.all(contacts.map(async (c) => {
      let storiesCount = 0; let lastStoryAt = null;
      try {
        storiesCount = await CommunitySubmission.countDocuments({ reporterId: c._id });
        const last = await CommunitySubmission.find({ reporterId: c._id }).sort({ createdAt: -1 }).limit(1).lean();
        lastStoryAt = last[0] ? last[0].createdAt : null;
      } catch (_) {}
      return {
        _id: c._id,
        fullName: c.fullName,
        email: c.email,
        phone: c.phoneFull || c.phoneNumber || null,
        city: c.cityTownVillage || null,
        state: c.stateName || null,
        country: c.country || null,
        organisation: c.organisationName || null,
        roleOrTitle: c.positionTitle || null,
        beats: c.beatsProfessional || [],
        yearsExperience: c.yearsExperience || null,
        verificationStatus: c.verificationLevel || 'pending',
        storiesCount,
        lastStoryAt,
      };
    }));

    return res.json({ ok: true, items, page, limit, total });
  } catch (e) {
    console.error('[ADMIN][journalists.applications] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});

// POST /api/admin/journalists/:id/approve
router.post('/journalists/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { contact, kind, identifier } = await findReporterContactByIdentifier(id);
    if (kind !== 'objectId' && kind !== 'email') {
      return res.status(400).json({ ok: false, message: 'Invalid journalist id' });
    }
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'verified';
    contact.verifiedAt = new Date();
    contact.verifiedBy = (req.admin && (req.admin.id || req.admin.email)) || null;
    await contact.save();
    return res.json({ ok: true, lookup: { kind, identifier } });
  } catch (e) {
    console.error('[ADMIN][journalists.approve] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to approve journalist' });
  }
});

// POST /api/admin/journalists/:id/reject
router.post('/journalists/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { contact, kind, identifier } = await findReporterContactByIdentifier(id);
    if (kind !== 'objectId' && kind !== 'email') {
      return res.status(400).json({ ok: false, message: 'Invalid journalist id' });
    }
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter not found' });
    contact.verificationLevel = 'revoked';
    contact.reporterType = 'journalist';
    contact.ethicsStrikes = (contact.ethicsStrikes || 0) + 1;
    await contact.save();
    return res.json({ ok: true, lookup: { kind, identifier } });
  } catch (e) {
    console.error('[ADMIN][journalists.reject] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to reject journalist' });
  }
});

module.exports = router;
