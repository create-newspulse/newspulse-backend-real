const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// POST /api/community/submissions (public)
router.post('/submissions', async (req, res) => {
  try {
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

    const doc = await CommunitySubmission.create({
      userName: finalName,
      name: finalName,
      email: String(email).trim().toLowerCase(),
      location: loc,
      category: String(category).trim(),
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
      status: 'pending',
      createdAt: new Date(),
    });

    return res.status(201).json({ ok: true, submissionId: doc._id.toString() });
  } catch (e) {
    console.error('[community] createSubmission error', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
