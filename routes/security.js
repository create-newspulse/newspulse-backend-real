// routes/security.js
// Security & Lockdown endpoints: escalation rules, incidents, threat scan.
// All responses use unified success wrapper: { ok: true, success: true, status: 200, data: ... }

const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middleware/adminAuth');

// Mock data stores (in-memory)
let escalationRules = [
  { id: 'rule-1', name: 'Multiple Failed Logins', severity: 'high', enabled: true, match: { failedLoginsWithinMin: 5, windowMinutes: 10 } },
  { id: 'rule-2', name: 'Suspicious Geo Login', severity: 'medium', enabled: true, match: { geoMismatch: true } },
];

let incidents = [
  { id: 'inc-1', type: 'failed_login_burst', severity: 'high', status: 'open', detectedAt: new Date(Date.now() - 3600_000).toISOString(), summary: '8 failed logins from IP 203.0.113.18 in 6m' },
  { id: 'inc-2', type: 'geo_mismatch', severity: 'medium', status: 'resolved', detectedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), resolvedAt: new Date(Date.now() - 90 * 60_000).toISOString(), summary: 'Login from unexpected region for founder account' },
];

let latestScan = {
  scanId: null,
  status: 'idle',
  findings: [],
  startedAt: null,
  completedAt: null,
};

// GET /api/security/escalation-rules
router.get('/escalation-rules', requireAdminAuth, (req, res) => {
  res.json({ ok: true, success: true, status: 200, data: { rules: escalationRules, lastUpdated: new Date().toISOString() } });
});

// GET /api/security/incidents
router.get('/incidents', requireAdminAuth, (req, res) => {
  res.json({ ok: true, success: true, status: 200, data: { items: incidents, total: incidents.length, lastUpdated: new Date().toISOString() } });
});

// GET /api/security/threat-scan (status of latest scan)
router.get('/threat-scan', requireAdminAuth, (req, res) => {
  res.json({ ok: true, success: true, status: 200, data: latestScan });
});

// POST /api/security/threat-scan (start new scan)
router.post('/threat-scan', requireAdminAuth, (req, res) => {
  const scanId = 'scan-' + Date.now();
  // Simulate an immediate completed scan with mock findings
  latestScan = {
    scanId,
    status: 'complete',
    findings: [
      { id: 'f-1', category: 'config', level: 'info', message: 'All security headers present.' },
      { id: 'f-2', category: 'access', level: 'warning', message: '2 stale admin sessions older than 24h.' },
    ],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  res.json({ ok: true, success: true, status: 200, data: latestScan });
});

module.exports = router;
