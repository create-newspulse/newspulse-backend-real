// routes/adminThreatRoutes.js
// Provides mock threat/security stats for the admin Threat Dashboard.
// Primary endpoint: GET /api/admin/threat-stats (mounted via server.js)
// Aliases may also mount this router at /api/dashboard and /dashboard for SPA compatibility.

const express = require('express');
const router = express.Router();

// Enhanced admin/founder auth gate.
// Accepts:
// - Bearer access JWT with role founder|admin
// - Legacy np_admin cookie (treat as admin)
// Falls back to 401 with consistent message string used elsewhere.
function requireAdmin(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    const cookieHeader = req.headers.cookie || '';
    let legacyAdminEmail = '';
    if (cookieHeader) {
      cookieHeader.split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k === 'np_admin') legacyAdminEmail = decodeURIComponent(v.join('=') || '');
      });
    }

    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    if (token) {
      try {
        const payload = require('jsonwebtoken').verify(token, secret);
        const role = payload.role;
        if (role === 'admin' || role === 'founder') {
          req.admin = { id: payload.sub, email: payload.email, role, name: payload.name };
          return next();
        }
        return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
      } catch (e) {
        // fall through to legacy cookie if present
        if (!legacyAdminEmail) {
          return res.status(401).json({ ok: false, success: false, status: 401, message: 'Admin auth required' });
        }
      }
    }

    if (legacyAdminEmail) {
      req.admin = { id: 'legacy-admin', email: legacyAdminEmail, role: 'admin', name: 'Admin' };
      return next();
    }

    return res.status(401).json({ ok: false, success: false, status: 401, message: 'Admin auth required' });
  } catch (e) {
    return res.status(401).json({ ok: false, success: false, status: 401, message: 'Admin auth required' });
  }
}

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
