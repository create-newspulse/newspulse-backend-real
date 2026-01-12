const express = require('express');
const { getPublishedSettings } = require('../controllers/publicSiteSettingsController');
const noCache = require('../middleware/noCache');

const router = express.Router();

// GET /api/public/settings - get published settings (no auth required)
router.get('/settings', noCache, getPublishedSettings);

module.exports = router;
