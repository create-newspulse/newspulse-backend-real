const express = require('express');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const router = express.Router();

// Phase-1 minimal public submission endpoint (POST /api/community/submissions)
router.post('/submissions', async (req, res) => {
  console.log('[CommunitySubmission] incoming body:', req.body);
  try {
    const b = req.body || {};
    const reporterName = (b.reporterName || b.name || '').toString().trim();
    const reporterEmail = (b.reporterEmail || b.email || '').toString().trim().toLowerCase();
    const storyText = (b.story || b.storyText || b.content || b.body || '').toString().trim();
    const category = (b.category || '').toString().trim();
    const headline = (b.headline || '').toString().trim();

    // Basic pre-validation to return clearer 400 before Mongoose
    const missing = [];
    if (!reporterName) missing.push('reporterName');
    if (!reporterEmail) missing.push('reporterEmail');
    if (!category) missing.push('category');
    if (!headline) missing.push('headline');
    if (!storyText) missing.push('story');
    if (missing.length) {
      return res.status(400).json({ ok: false, error: 'validation_error', details: { missing } });
    }

    // Optional fields
    const ageGroup = (b.ageGroup || b.reporterAgeGroup || '').toString().trim() || undefined;
    const location = (b.location || b.city || b.reporterLocation || '').toString().trim() || undefined;
    const media = (b.mediaUrl || b.mediaLink || '').toString().trim() || undefined;

    const saved = await CommunitySubmission.create({
      reporterName,
      reporterEmail,
      headline,
      body: storyText,
      category,
      ageGroup,
      reporterAgeGroup: ageGroup,
      location,
      reporterLocation: location,
      mediaUrl: media,
      mediaLink: media,
      acceptTerms: b.acceptTerms === true,
      acceptedPolicy: b.acceptTerms === true,
      status: 'under_review'
    });

    return res.status(201).json({
      ok: true,
      id: saved._id.toString(),
      status: saved.status || 'under_review'
    });
  } catch (err) {
    console.error('[CommunitySubmission] error while saving:', err);
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({
        ok: false,
        error: 'validation_error',
        details: err.errors
      });
    }
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
