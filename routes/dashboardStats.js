// routes/dashboardStats.js
const express = require('express');
const router = express.Router();
const { getSystemStats, getDashboardStats } = require('../controllers/dashboardStatsController');

// Root health for compatibility alongside stats endpoints
router.get('/health', (req, res) => {
	res.setHeader('content-type', 'application/json; charset=utf-8');
	return res.status(200).json({
		ok: true,
		service: 'newspulse-backend',
		env: process.env.NODE_ENV || 'development',
		uptimeSeconds: Math.floor(process.uptime()),
		timestamp: new Date().toISOString(),
	});
});

// SIMPLE HEALTH / STATUS ROUTE
// Final URL: GET /api/stats   (because we will mount this router on /api)
router.get('/stats', getSystemStats);

// ADMIN DASHBOARD STATS
// Final URL: GET /api/dashboard-stats
router.get('/dashboard-stats', getDashboardStats);

module.exports = router;
