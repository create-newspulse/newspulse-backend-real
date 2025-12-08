const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { runCommunityAiChecks } = require('../services/communityAi');
const { submitCommunityReport, listMyCommunityReports } = require('../controllers/communityReporterController');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// Map internal status -> external Phase 1 label
function externalStatus(internal) {
  switch (internal) {
    case 'NEW': return 'pending';
    case 'APPROVED': return 'approved';
    case 'REJECTED': return 'rejected';
    default: return 'pending';
  }
}

// POST /api/community-reporter/submissions (public, no auth)
router.post('/submissions', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      name,
      fullName,
      email,
      location,
      category,
      headline,
      story,
      phone,
      city,
      state,
      country,
      preferredLanguages,
      heardAbout,
      isProfessionalJournalist,
      communityInterests,
      organisationName,
      organisationType,
      positionTitle,
      beatsProfessional,
      yearsExperience,
      websiteOrPortfolio,
      socialLinks,
      journalistCharterAccepted,
    } = body;
    const errors = [];
    if (!name || !String(name).trim()) errors.push('name required');
    if (!email || !String(email).trim()) errors.push('email required');
    if (!location || !String(location).trim()) errors.push('location required');
    if (!category || !String(category).trim()) errors.push('category required');
    if (!headline || !String(headline).trim()) errors.push('headline required');
    if (!story || !String(story).trim()) errors.push('story required');
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

    // Upsert reporter contact (community type)
    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    let reporterResult = null;
    try {
      const reporterType = isProfessionalJournalist ? 'journalist' : 'community';
      reporterResult = await upsertReporterContactFromPayload({
        name: (fullName || name || '').trim(),
        email: email.trim().toLowerCase(),
        phone: phone,
        city: (city || location || '').trim(),
        state: state,
        country: country,
        reporterType,
        languages: Array.isArray(preferredLanguages) ? preferredLanguages : undefined,
        interests: Array.isArray(communityInterests) ? communityInterests : undefined,
        heardAbout,
        organisationName,
        organisationType,
        positionTitle,
        beatsProfessional,
        yearsExperience,
        websiteOrPortfolio,
        socialLinks,
        journalistCharterAccepted,
      });
    } catch (err) {
      console.error('[COMMUNITY_REPORTER][contact-upsert-failed]', err?.message || err);
      // Continue without reporterContact (fallback legacy behavior)
    }

    const cityNorm = (city || location || '').trim();
    const stateNorm = (state || '').trim();
    const countryNorm = (country || '').trim();
    const submission = await CommunitySubmission.create({
      // Required duplicates for model
      reporterName: (fullName || name || '').trim(),
      reporterEmail: (email || '').trim().toLowerCase(),
      // Legacy/alias fields for compatibility
      name: (name || '').trim(),
      email: (email || '').trim().toLowerCase(),
      category: (category || '').trim(),
      headline: (headline || '').trim(),
      body: (story || '').trim(), // underlying field
      // Normalized location object expected by schema
      location: { city: cityNorm || null, state: stateNorm || null, country: countryNorm || null },
      reporterLocation: cityNorm || undefined,
      city: cityNorm || undefined,
      state: stateNorm || undefined,
      country: countryNorm || undefined,
      // Defaults
      status: 'PENDING_FOUNDER',
      reporterId: reporterResult ? reporterResult.contactId : undefined,
      sourceType: reporterResult ? (reporterResult.contact.reporterType === 'journalist' ? 'journalist' : 'community') : (isProfessionalJournalist ? 'journalist' : 'community'),
      reporterVerificationLevel: (function () {
        if (!reporterResult || !reporterResult.contact || !reporterResult.contact.verificationLevel) return 'unverified';
        const v = reporterResult.contact.verificationLevel;
        if (v === 'verified') return 'journalist_verified';
        if (v === 'pending') return 'journalist_pending';
        return 'unverified';
      })(),
    });
    if (process.env.NODE_ENV !== 'test') {
      try {
        await runCommunityAiChecks(submission);
      } catch (err) {
        console.error('[CommunityAI] Failed to process reporter submission', err?.message || err);
        submission.status = 'PENDING_FOUNDER';
        try { await submission.save(); } catch (_) {}
      }
    }
    return res.status(201).json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      story: submission.body,
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
      status: externalStatus(submission.status),
      reporterId: submission.reporterId || null,
      sourceType: submission.sourceType,
      reporterVerificationLevel: submission.reporterVerificationLevel,
      createdAt: submission.createdAt,
    }});
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][create-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

// Phase 1 endpoints (public): submit + list by email
router.post('/submit', submitCommunityReport);
router.get('/my-stories', listMyCommunityReports);

// Note: queue endpoint temporarily served publicly via app-level route in server.js

module.exports = router;