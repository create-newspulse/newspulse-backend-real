const express = require('express');
const { requireFounderAuth } = require('../middleware/adminAuth');
const {
  extractAdminFeatureVisibilityPatch,
  getAdminFeatureVisibility,
  saveAdminFeatureVisibility,
} = require('../services/adminFeatureVisibilityService');

const router = express.Router();

router.get('/safe-owner-zone/feature-visibility', requireFounderAuth, async (_req, res) => {
  try {
    const visibility = await getAdminFeatureVisibility();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, visibility });
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][feature-visibility][get] failed', error?.stack || error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load admin feature visibility' });
  }
});

router.put('/safe-owner-zone/feature-visibility', requireFounderAuth, async (req, res) => {
  try {
    const { patch, invalidKeys, invalidValueKeys } = extractAdminFeatureVisibilityPatch(req.body || {});

    if (invalidKeys.length || invalidValueKeys.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid admin feature visibility payload',
        invalidKeys,
        invalidValueKeys,
      });
    }

    const visibility = await saveAdminFeatureVisibility(patch || {});
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, visibility });
  } catch (error) {
    console.error('[SAFE_OWNER_ZONE][feature-visibility][put] failed', error?.stack || error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to save admin feature visibility' });
  }
});

module.exports = router;