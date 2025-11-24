const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { runCommunityAiChecks } = require('../services/communityAi');
const router = express.Router();

// POST /api/community/submissions (simplified public endpoint)
router.post('/submissions', async (req, res) => {
  try {
    const { userName, email, location, category, headline, body, mediaLink } = req.body || {};
    if (!userName || !email || !headline || !body) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const submission = await CommunitySubmission.create({
      userName: String(userName).trim(), // virtual maps to name
      email: String(email).trim().toLowerCase(),
      location: location ? String(location).trim() : undefined,
      category: category ? String(category).trim() : undefined,
      headline: String(headline).trim(),
      body: String(body).trim(),
      mediaLink: mediaLink ? String(mediaLink).trim() : undefined,
      status: 'NEW',
    });

    // Phase 2 AI stub: mirror content + status advance
    await runCommunityAiChecks(submission);

    return res.status(201).json({ success: true });
  } catch (e) {
    console.error('[COMMUNITY][create-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

module.exports = router;
