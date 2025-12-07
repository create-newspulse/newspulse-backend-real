const express = require('express');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const {
	getCommunityReporterSettings,
	updateCommunityReporterSettings,
} = require('../controllers/communityReporterSettingsController');

const router = express.Router();

// GET /api/admin/settings/community-reporter
router.get('/settings/community-reporter', requireAdminAuth, getCommunityReporterSettings);

// POST /api/admin/settings/community-reporter
router.post('/settings/community-reporter', requireAdminAuth, updateCommunityReporterSettings);

// Compatibility: accept PUT and treat same as POST
router.put('/settings/community-reporter', requireAdminAuth, updateCommunityReporterSettings);

module.exports = router;
