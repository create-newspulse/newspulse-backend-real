const express = require('express');
const { getPublicFeatureToggles } = require('../controllers/publicFeatureToggleController');

const router = express.Router();

// Public read-only feature toggles
// GET /public/feature-toggles
router.get('/public/feature-toggles', getPublicFeatureToggles);

module.exports = router;
