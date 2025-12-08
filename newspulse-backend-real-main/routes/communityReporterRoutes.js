const express = require('express');
const { submitStory, listStoriesByReporter, listReporters, getCommunityStats } = require('../controllers/communityReporterController');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

router.post('/submit', submitStory);
router.get('/my-stories', listStoriesByReporter);

// Admin reporter directory and stats
router.get('/admin/reporters', requireAdminAuth, listReporters);
router.get('/admin/community/stats', requireAdminAuth, getCommunityStats);

// Note: queue endpoint temporarily provided at app level without auth (see server.js)

module.exports = router;
