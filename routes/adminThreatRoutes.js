// routes/adminThreatRoutes.js
// Provides mock threat/security stats for the admin Threat Dashboard.
// Primary endpoint: GET /api/admin/threat-stats (mounted via server.js)
// Aliases may also mount this router at /api/dashboard and /dashboard for SPA compatibility.

const express = require('express');
const router = express.Router();

const { requireFounderOrAdmin: requireAdmin } = require('../middleware/adminAuth');

// GET /threat-stats
router.get('/threat-stats', requireAdmin, async (req, res) => {
  try {
    // Unified stub threat intelligence payload (expand later with real metrics)
    const lastUpdated = new Date().toISOString();
    const summary = {
      suspiciousLogins24h: 0,
      failedLogins24h: 0,
      blockedIPs: 0,
      alertsTriggered24h: 0,
    };
    const recentEvents = [];
    const topRegions = [];
    const overallRiskScore = 2; // 1–5 scale (low risk stub)

    // Provide both flattened shape AND legacy data wrapper for backward compatibility
    res.json({
      ok: true,
      success: true,
      status: 200,
      lastUpdated,
      overallRiskScore,
      summary,
      recentEvents,
      topRegions,
      // Legacy field (older admin panel builds looked at data.*)
      data: {
        lastUpdated,
        overallRiskScore,
        ...summary,
        recentEvents,
        topRegions,
      },
    });
  } catch (err) {
    console.error('Error in /threat-stats:', err);
    res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load threat stats' });
  }
});

module.exports = router;
