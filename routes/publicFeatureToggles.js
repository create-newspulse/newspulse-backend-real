// routes/publicFeatureToggles.js
const express = require('express');
const router = express.Router();

const {
  getPublicCommunityFeatureToggles,
} = require('../controllers/admin/communityFeatureToggles');

// Public read-only endpoint used by Next.js
// GET /api/public/feature-toggles
router.get('/feature-toggles', getPublicCommunityFeatureToggles);

module.exports = router;
