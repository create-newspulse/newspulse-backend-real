const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { runCommunityAiChecks } = require('../services/communityAi');
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

    const finalName = (name || userName || '').trim();
    const finalBody = (story || body || '').trim();
    const finalHeadline = (headline || '').trim();
    const finalEmail = (email || '').trim().toLowerCase();
    const finalCategory = category ? String(category).trim() : undefined;
    const finalLocation = location ? String(location).trim() : undefined;

    if (!finalName || !finalEmail || !finalHeadline || !finalBody || !finalCategory) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Pre-AI defaults
    let aiHeadline = finalHeadline;
    let aiBody = finalBody;
    let riskScore = 0;
    let flags = [];
    let status = 'NEW';

    // Create initial submission (NEW)
    const submission = await CommunitySubmission.create({
      userName: finalName,
      email: finalEmail,
      location: finalLocation,
      category: finalCategory,
      headline: finalHeadline,
      body: finalBody,
      mediaLink: mediaLink ? String(mediaLink).trim() : undefined,
      aiHeadline,
      aiBody,
      riskScore,
      flags,
      status,
    });

    // AI processing - never throw outward
    try {
      // Only attempt if API key exists
      const hasKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_NEWS_PULSE;
      if (hasKey && runCommunityAiChecks) {
        await runCommunityAiChecks(submission);
      } else {
        // No key -> manual review path
        submission.status = 'PENDING_FOUNDER';
        await submission.save();
      }
    } catch (err) {
      console.error('[CommunityReporter] AI pipeline failed, fallback engaged:', err?.message || err);
      submission.aiHeadline = finalHeadline;
      submission.aiBody = finalBody;
      submission.riskScore = 0;
      submission.flags = [];
      submission.status = 'PENDING_FOUNDER';
      try { await submission.save(); } catch (_) {}
    }

    return res.status(201).json({ success: true, submission });
  } catch (e) {
    console.error('[CommunityReporter] Failed to create submission', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

module.exports = router;
