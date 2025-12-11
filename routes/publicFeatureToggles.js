// routes/publicFeatureToggles.js
const express = require('express');
const router = express.Router();

const {
  getPublicCommunityFeatureToggles,
} = require('../controllers/admin/communityFeatureToggles');

const {
  getPublicCommunitySettings,
} = require('../controllers/admin/communitySettingsController');

// Public read-only endpoint used by Next.js
// GET /api/public/feature-toggles
router.get('/feature-toggles', getPublicCommunityFeatureToggles);

// GET /api/public/community/settings
router.get('/community/settings', getPublicCommunitySettings);

module.exports = router;
