// routes/adminThreatRoutes.js
// Provides mock threat/security stats for the admin Threat Dashboard.
// Primary endpoint: GET /api/admin/threat-stats (mounted via server.js)
// Aliases may also mount this router at /api/dashboard and /dashboard for SPA compatibility.

const express = require('express');
const router = express.Router();

// Simple admin auth gate (cookie or bearer token). Centralized here for now.
function requireAdmin(req, res, next) {
  try {
    const auth = String(req.headers['authorization'] || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const cookieHeader = req.headers.cookie || '';
    let email = '';
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k === 'np_admin') email = decodeURIComponent(v.join('=') || '');
    });
    if (!bearer && !email) {
      return res.status(401).json({ ok: false, success: false, status: 401, message: 'Admin auth required' });
    }
    req.adminEmail = email || 'admin@newspulse.ai';
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, success: false, status: 401, message: 'Admin auth failed' });
  }
}

// GET /threat-stats
router.get('/threat-stats', requireAdmin, async (req, res) => {
  try {
    // Mock values; replace with real aggregation logic later.
    const data = {
      suspiciousLogins24h: 3,
      failedLogins24h: 12,
      blockedIPs: 5,
      firewallAlerts24h: 0,
      lastUpdated: new Date().toISOString(),
    };
    // Success wrapper expected by frontend fetchJson helper
    res.json({ ok: true, success: true, status: 200, data });
  } catch (err) {
    console.error('Error in /threat-stats:', err);
    res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load threat stats' });
  }
});

module.exports = router;
