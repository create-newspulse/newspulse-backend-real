const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { getCommunitySettings } = require('../../services/communitySettingsService');

const router = express.Router();
// GET /api/community/settings (public)
router.get('/settings', async (req, res) => {
  try {
    const settings = await getCommunitySettings();
    return res.json({
      ok: true,
      settings: {
        communityReporterEnabled: settings.communityReporterEnabled,
        allowNewSubmissions: settings.allowNewSubmissions,
        allowMyStoriesPortal: settings.allowMyStoriesPortal,
        allowJournalistApplications: settings.allowJournalistApplications,
      },
    });
  } catch (err) {
    console.error('[COMMUNITY][settings][error]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load settings' });
  }
});

// POST /api/community/submissions (public)
router.post('/submissions', async (req, res) => {
  try {
    // Enforce settings toggles
    try {
      const { getCommunitySettings } = require('../../services/communitySettingsService');
      const settings = await getCommunitySettings();
      if (!settings.communityReporterEnabled || !settings.allowNewSubmissions) {
        return res.status(503).json({
          ok: false,
          code: 'COMMUNITY_CLOSED',
          message: 'Community Reporter submissions are currently closed.',
        });
      }
    } catch (cfgErr) {
      // continue if settings service fails
    }
    const { name, userName, email, location, category, headline, body, story, storyText, content, mediaLink, mediaUrl, age, ageGroup, acceptTerms } = req.body || {};

    const bodyText = (story || storyText || content || body || '').toString().trim();
    const errors = [];
    const finalName = (name || userName || '').toString().trim();
    if (!finalName) errors.push('name required');
    if (!email || !String(email).trim()) errors.push('email required');
    if (!category || !String(category).trim()) errors.push('category required');
    if (!headline || !String(headline).trim()) errors.push('headline required');
    if (!bodyText) errors.push('story required');
    if (acceptTerms !== true) errors.push('acceptTerms must be true');
    if (errors.length) {
      return res.status(400).json({ error: 'invalid_payload', details: errors });
    }

    const loc = location ? String(location).trim() : undefined;
    const normalizedAgeGroup = (ageGroup || age || '').toString().trim();
    const media = mediaLink || mediaUrl;

    // Category normalization for consistency with primary schema (safe even if not enum)
    const allowedCategories = new Set(['regional','youth','campus','civic','tip','other']);
    const catRaw = String(category || '').trim().toLowerCase();
    const catFinal = allowedCategories.has(catRaw) ? catRaw : 'other';

    const doc = await CommunitySubmission.create({
      userName: finalName,
      name: finalName,
      email: String(email).trim().toLowerCase(),
      location: loc,
      category: catFinal,
      headline: String(headline).trim(),
      body: bodyText,
      mediaLink: media ? String(media).trim() : undefined,
      ageGroup: normalizedAgeGroup || undefined,
      acceptTerms: true,
      reporterName: finalName,
      reporterEmail: String(email).trim().toLowerCase(),
      reporterLocation: loc || '',
      reporterAgeGroup: (function mapAge(v){
        const s = (v || '').toString().trim();
        const allowed = new Set(['Under 18','18–24','25–40','41+']);
        if (allowed.has(s)) return s;
        return '25–40';
      })(normalizedAgeGroup),
      acceptedPolicy: true,
      status: (async () => {
        try {
          const { getCommunitySettings } = require('../../services/communitySettingsService');
          const s = await getCommunitySettings();
          return s.safeModeManualReviewOnly ? 'pending' : 'pending';
        } catch (_) {
          return 'pending';
        }
      })(),
      createdAt: new Date(),
    });

    return res.status(201).json({ ok: true, submissionId: doc._id.toString() });
  } catch (e) {
    if (e && e.name === 'ValidationError') {
      const fields = Object.keys(e.errors || {});
      return res.status(400).json({ error: 'invalid_payload', details: fields.length ? fields : ['validation_error'] });
    }
    console.error('[community] createSubmission error', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
