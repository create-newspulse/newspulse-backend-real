// routes/adminThreatRoutes.js
// Provides mock threat/security stats for the admin Threat Dashboard.
// Endpoint: GET /api/admin/threat-stats (mounted via server.js)

const express = require('express');
const router = express.Router();

// GET /threat-stats
router.get('/threat-stats', async (req, res) => {
  try {
    // Mock values; replace with real aggregation logic later.
    res.json({
      suspiciousLogins24h: 0,
      failedLogins24h: 0,
      blockedIPs: 0,
      firewallAlerts24h: 0,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error in /threat-stats:', err);
    res.status(500).json({ message: 'Failed to load threat stats' });
  }
});

module.exports = router;
