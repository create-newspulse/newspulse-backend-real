const express = require('express');

const router = express.Router();

// GET /api/community-reporter/my-stories
router.get('/my-stories', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    console.log('[CommunityReporter] my-stories probe', { email });
    // Stubbed response; will connect to DB later
    return res.status(200).json({ success: true, items: [], total: 0 });
  } catch (err) {
    console.error('[CommunityReporter] my-stories error', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
});

// POST /api/community-reporter/submit
router.post('/submit', async (req, res) => {
  try {
    const {
      reporterName,
      reporterEmail,
      reporterPhone,
      reporterCity,
      reporterState,
      reporterCountry,
      reporterType,
      category,
      headline,
      storyText,
      ageGroup,
      preferredLanguages,
    } = req.body || {};

    console.log('[CommunityReporter] submit payload', {
      reporterName,
      reporterEmail,
      reporterPhone,
      reporterCity,
      reporterState,
      reporterCountry,
      reporterType,
      category,
      headline,
      storyText,
      ageGroup,
      preferredLanguages,
    });

    // TODO: save to DB + queue for review later

    return res.status(201).json({
      success: true,
      message: 'Story received',
      refId: 'NP-CR-TEST-0001',
    });
  } catch (err) {
    console.error('[CommunityReporter] submit error', err && err.message ? err.message : err);
    return res.status(500).json({
      success: false,
      error: 'submit_failed',
      message: (err && err.message) || 'Unexpected error',
    });
  }
});

module.exports = router;
