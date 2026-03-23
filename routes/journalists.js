const express = require('express');
const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// POST /api/journalists/apply (public)
router.post('/apply', async (req, res) => {
  try {
    // Enforce toggle: journalist applications open
    try {
      const { getCommunitySettings } = require('../services/communitySettingsService');
      const settings = await getCommunitySettings();
      if (!settings.allowJournalistApplications) {
        return res.status(503).json({ ok: false, message: 'Journalist applications are currently closed.' });
      }
    } catch (_) {}
    const body = req.body || {};
    const {
      name,
      email,
      phone,
      city,
      state,
      country,
      organisationName,
      organisationType,
      positionTitle,
      beats,
      yearsExperience,
      languages,
      websiteOrPortfolio,
      socialLinks,
    } = body;

    const errors = [];
    function reqStr(val, label) { if (!val || !String(val).trim()) errors.push(label + ' required'); }
    reqStr(name, 'name');
    reqStr(email, 'email');
    reqStr(phone, 'phone');
    reqStr(city, 'city');
    reqStr(state, 'state');
    reqStr(country, 'country');
    reqStr(organisationName, 'organisationName');
    reqStr(organisationType, 'organisationType');
    reqStr(positionTitle, 'positionTitle');
    if (!Array.isArray(beats) || !beats.length) errors.push('beats required');
    if (errors.length) return res.status(400).json({ ok: false, success: false, message: 'Validation failed', errors });

    const { contact, contactId } = await upsertReporterContactFromPayload({
      name,
      email,
      phone,
      city,
      state,
      country,
      reporterType: 'journalist',
      organisationName,
      organisationType,
      positionTitle,
      beatsProfessional: beats,
      yearsExperience,
      languages,
      websiteOrPortfolio,
      socialLinks,
      journalistCharterAccepted: body.journalistCharterAccepted === true,
    });

    // Ensure new journalists default to pending (service already sets pending)
    if (contact.verificationLevel !== 'verified' && contact.verificationLevel !== 'pending') {
      contact.verificationLevel = 'pending';
      if (contact && typeof contact.save === 'function') {
        await contact.save();
      } else {
        try {
          await ReporterContact.findOneAndUpdate(
            { email: String(contact.email || email || '').trim().toLowerCase() },
            { $set: { reporterType: 'journalist', verificationLevel: 'pending' } },
            { new: true }
          );
        } catch (_) {}
      }
    }

    return res.status(200).json({
      ok: true,
      reporterId: contactId.toString(),
      message: 'Application received',
    });
  } catch (e) {
    console.error('[JOURNALISTS][apply-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to process application' });
  }
});

// GET /admin/community/journalist-applications (admin)
router.get('/admin/community/journalist-applications', requireAdminAuth, async (req, res) => {
  try {
    const { status = 'all' } = req.query || {};
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    const filter = { reporterType: 'journalist' };
    if (status === 'pending') filter.verificationLevel = 'pending';
    else if (status === 'verified') filter.verificationLevel = 'verified';
    else filter.verificationLevel = { $in: ['pending', 'verified'] }; // exclude unverified from list unless filtering explicitly later

    const [items, total] = await Promise.all([
      ReporterContact.find(filter).sort({ verifiedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    // Optionally compute story counts – lightweight pass (count only if reporterId present)
    const enriched = await Promise.all(items.map(async (c) => {
      let storyCount = 0;
      try {
        storyCount = await CommunitySubmission.countDocuments({ reporterId: c._id });
      } catch (_) {}
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
  } catch (e) {
    console.error('[JOURNALISTS][list-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});

// POST /admin/community/journalists/:reporterId/verify
router.post('/admin/community/journalists/:reporterId/verify', requireAdminAuth, async (req, res) => {
  try {
    const { reporterId } = req.params || {};
    if (!reporterId) return res.status(400).json({ ok: false, message: 'Invalid reporterId' });
    const contact = await ReporterContact.findById(reporterId);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'verified';
    contact.verifiedBy = (req.admin && req.admin.id) || null;
    contact.verifiedAt = new Date();
    await contact.save();
    try {
      await CommunitySubmission.updateMany(
        { reporterId: contact._id },
        { $set: { sourceType: 'journalist', reporterVerificationLevel: 'verified' } }
      );
    } catch (bulkErr) {
      console.warn('[JOURNALISTS][bulk-update-warning]', bulkErr?.message || bulkErr);
    }
    return res.json({ ok: true, status: 'verified', reporterId: contact._id.toString() });
  } catch (e) {
    console.error('[JOURNALISTS][verify-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to verify journalist' });
  }
});

// POST /admin/community/journalists/:reporterId/reject
router.post('/admin/community/journalists/:reporterId/reject', requireAdminAuth, async (req, res) => {
  try {
    const { reporterId } = req.params || {};
    if (!reporterId) return res.status(400).json({ ok: false, message: 'Invalid reporterId' });
    const contact = await ReporterContact.findById(reporterId);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'community';
    contact.verificationLevel = 'unverified';
    contact.verifiedBy = null;
    contact.verifiedAt = null;
    await contact.save();
    try {
      await CommunitySubmission.updateMany(
        { reporterId: contact._id },
        { $set: { sourceType: 'community', reporterVerificationLevel: 'unverified' } }
      );
    } catch (bulkErr) {
      console.warn('[JOURNALISTS][bulk-downgrade-warning]', bulkErr?.message || bulkErr);
    }
    return res.json({ ok: true, status: 'unverified', reporterId: contact._id.toString() });
  } catch (e) {
    console.error('[JOURNALISTS][reject-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to reject journalist' });
  }
});

module.exports = router;