const express = require('express');
const { getSystemSettings, updateCommunityConfig } = require('../services/systemSettingsService');
let requireAdminAuth = (_req, _res, next) => next();
try { ({ requireAdminAuth } = require('../middleware/adminAuth')); } catch (_) {}

const router = express.Router();

// GET /api/admin/community-reporter/config
router.get('/community-reporter/config', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSystemSettings();
    return res.json({ ok: true, communityMyStoriesEnabled: Boolean(settings.communityMyStoriesEnabled) });
  } catch (e) {
    console.error('[admin:community-reporter:config][error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Could not load community reporter config.' });
  }
});

// PATCH /api/admin/community-reporter/config
router.patch('/community-reporter/config', requireAdminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.communityMyStoriesEnabled !== 'undefined' && typeof body.communityMyStoriesEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'Invalid communityMyStoriesEnabled flag (boolean required).' });
    }
    const updated = await updateCommunityConfig({ communityMyStoriesEnabled: body.communityMyStoriesEnabled });
    return res.json({ ok: true, communityMyStoriesEnabled: Boolean(updated.communityMyStoriesEnabled) });
  } catch (e) {
    console.error('[admin:community-reporter:config:update][error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Could not load/update community reporter config.' });
  }
});

module.exports = router;
