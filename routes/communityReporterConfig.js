// Public config for Community Reporter (used by frontend)
const express = require('express');
const { getSystemSettings } = require('../services/systemSettingsService');

const router = express.Router();

// GET /api/community-reporter/config
router.get('/config', async (req, res) => {
  try {
    const settings = await getSystemSettings();
    return res.json({ ok: true, communityMyStoriesEnabled: Boolean(settings.communityMyStoriesEnabled) });
  } catch (e) {
    console.error('[community-reporter:config][error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Could not load community reporter config.' });
  }
});

module.exports = router;
