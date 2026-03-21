const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { getAdminDashboardStats } = require('../controllers/adminDashboardStatsController');

const router = express.Router();

// GET /api/admin/dashboard/stats
router.get('/stats', requireAdminAuth, getAdminDashboardStats);

module.exports = router;
