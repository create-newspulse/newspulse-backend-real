const express = require('express');

const { getPublicAdSettings } = require('../controllers/adSettingsController');

const router = express.Router();

// GET /api/public/ad-settings
router.get('/ad-settings', getPublicAdSettings);

module.exports = router;
