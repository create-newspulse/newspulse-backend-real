const express = require('express');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const router = express.Router();

// Phase-1 minimal public submission endpoint (POST /api/community/submissions)
router.post('/submissions', async (req, res) => {
  try {
    const {
      name,
      email,
      city,
      location,
      category,
      headline,
      story,
      storyText,
      content,
      body,
      mediaLink,
      mediaUrl,
      age,
      ageGroup,
      acceptTerms,
    } = req.body || {};

    const bodyText = (story || storyText || content || body || '').toString().trim();
    const errors = [];
    if (!name || !String(name).trim()) errors.push('name required');
    if (!email || !String(email).trim()) errors.push('email required');
    if (!category || !String(category).trim()) errors.push('category required');
    if (!headline || !String(headline).trim()) errors.push('headline required');
    if (!bodyText) errors.push('story required');
    if (acceptTerms !== true) errors.push('acceptTerms must be true');

    if (errors.length) {
      return res.status(400).json({ error: 'invalid_payload', details: errors });
    }

    // Ensure MongoDB is connected (avoid generic 500 when DB down)
    if (mongoose.connection?.readyState !== 1) {
      console.warn('[community] DB not connected; rejecting submission');
      return res.status(503).json({ error: 'server_unavailable' });
    }

    const loc = location ? String(location).trim() : (city ? String(city).trim() : undefined);
    const normalizedAgeGroup = (ageGroup || age || '').toString().trim();
    const media = mediaLink || mediaUrl;

    const submission = await CommunitySubmission.create({
      // Canonical submitter fields
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      city: city ? String(city).trim() : undefined,
      location: loc,
      category: String(category).trim(),
      headline: String(headline).trim(),
      body: bodyText,
      mediaUrl: media ? String(media).trim() : undefined,
      // Public form optional fields
      ageGroup: normalizedAgeGroup || undefined,
      acceptTerms: true,
      // Reporter mirror fields (required in schema)
      reporterName: String(name).trim(),
      reporterEmail: String(email).trim().toLowerCase(),
      reporterLocation: loc || '',
      reporterAgeGroup: (function mapAge(v){
        const s = (v || '').toString().trim();
        const allowed = new Set(['Under 18','18–24','25–40','41+']);
        if (allowed.has(s)) return s;
        return '25–40';
      })(normalizedAgeGroup),
      acceptedPolicy: true,
      status: 'pending',
    });

    return res.status(201).json({ ok: true, submissionId: submission._id.toString() });
  } catch (err) {
    console.error('[community] createSubmission error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
