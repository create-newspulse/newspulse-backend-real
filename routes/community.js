const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { runCommunityAiChecks } = require('../services/communityAi');
const { computeCommunityPriority } = require('../services/communityPriority');
const router = express.Router();

// POST /api/community/submissions (public form - hardened)
router.post('/submissions', async (req, res) => {
  try {
    // Accept both Phase1 (userName/body) and newer (name/story) field names.
    const {
      userName, name,
      email,
      location,
      category,
      headline,
      body,
      story,
      mediaLink,
    } = req.body || {};

      router.post('/submissions', async (req, res) => {
        try {
          const { name, email, city, category, headline, story, mediaUrl } = req.body || {};

          if (!name || !email || !headline || !story) {
            return res.status(400).json({ ok: false, success: false, message: 'Missing required fields' });
          }

          const submission = await CommunitySubmission.create({
            name: String(name).trim(),
            email: String(email).trim().toLowerCase(),
            // map city -> location in existing schema
            location: city ? String(city).trim() : undefined,
            category: category ? String(category).trim() : undefined,
            headline: String(headline).trim(),
            body: String(story).trim(),
            mediaUrl: mediaUrl ? String(mediaUrl).trim() : undefined,
            status: 'NEW',
          });

          return res.status(201).json({ ok: true, success: true, id: submission._id });
        } catch (err) {
          console.error('Error creating community submission', err?.message || err);
          return res.status(500).json({ ok: false, success: false, message: 'Internal server error' });
        }
      });

      module.exports = router;
      userName: finalName,
