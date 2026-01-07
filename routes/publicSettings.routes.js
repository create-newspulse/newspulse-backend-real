const express = require('express');
const { getPublishedSettings } = require('../controllers/publicSiteSettingsController');

const router = express.Router();

// GET /api/public/settings - get published settings (no auth required)
router.get('/settings', getPublishedSettings);

module.exports = router;
