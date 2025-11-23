const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// POST /api/community/submissions (public)
router.post('/submissions', async (req, res) => {
  try {
    const { userName, email, location, category, headline, body, mediaLink } = req.body || {};
    const errors = [];
    if (!email || !String(email).trim()) errors.push('email required');
    if (!headline || !String(headline).trim()) errors.push('headline required');
    if (!body || !String(body).trim()) errors.push('body required');
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    await CommunitySubmission.create({
      userName: String(userName || '').trim(),
      email: String(email).trim().toLowerCase(),
      location: location ? String(location).trim() : undefined,
      category: category ? String(category).trim() : undefined,
      headline: String(headline).trim(),
      body: String(body).trim(),
      mediaLink: mediaLink ? String(mediaLink).trim() : undefined,
      status: 'NEW',
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true });
  } catch (e) {
    console.error('[COMMUNITY][create-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

module.exports = router;
