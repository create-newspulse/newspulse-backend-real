const express = require('express');
const { getPublicCommunitySettings } = require('../../controllers/public/communitySettingsPublicController');

const router = express.Router();

// GET /api/public/community/settings (mounted at /api/public/community)
router.get('/settings', getPublicCommunitySettings);

module.exports = router;
