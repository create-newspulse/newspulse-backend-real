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
      content,
      mediaUrl,
    } = req.body || {};

    const bodyText = (story || content || '').toString().trim();
    if (!name || !email || !headline || !bodyText) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing required fields' });
    }

    // Ensure MongoDB is connected (avoid generic 500 when DB down)
    if (mongoose.connection?.readyState !== 1) {
      console.warn('[Community] MongoDB not connected; rejecting submission');
      return res.status(503).json({ ok: false, success: false, message: 'Service temporarily unavailable. Please try again later.' });
    }

    const submission = await CommunitySubmission.create({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      city: city ? String(city).trim() : undefined,
      location: location ? String(location).trim() : (city ? String(city).trim() : undefined),
      category: category ? String(category).trim() : undefined,
      headline: String(headline).trim(),
      body: bodyText,
      mediaUrl: mediaUrl ? String(mediaUrl).trim() : undefined,
      status: 'pending',
    });

    return res.status(201).json({ ok: true, success: true, id: submission._id });
  } catch (err) {
    console.error('[Community] Error creating submission', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Internal server error' });
  }
});

module.exports = router;
