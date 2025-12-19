// routes/alerts.js
// Alerts router: provides Smart Alerts settings endpoints used by admin panel.

const express = require('express');
const router = express.Router();
const { requireAdminAuth } = require('../middleware/adminAuth');

// In-memory settings store (replace with persistent DB later)
let alertSettings = {
  emailEnabled: true,
  dashboardAlertsEnabled: true,
  aiPriorityTaggingEnabled: false,
  escalationEnabled: true,
  lastUpdated: new Date().toISOString(),
};

// Use shared admin auth middleware for consistent 401/403 behavior

// GET /api/alerts/settings
router.get('/settings', requireAdminAuth, (req, res) => {
  // Present both new flattened shape and existing data wrapper for compatibility.
  const payload = {
    ok: true,
    success: true,
    status: 200,
    channels: {
      email: alertSettings.emailEnabled,
      dashboard: alertSettings.dashboardAlertsEnabled,
    },
    aiPriorityTagging: alertSettings.aiPriorityTaggingEnabled,
    escalationEnabled: alertSettings.escalationEnabled,
    lastUpdated: alertSettings.lastUpdated,
    // Legacy wrapper
    data: alertSettings,
  };
  res.json(payload);
});

// PUT /api/alerts/settings
router.put('/settings', requireAdminAuth, (req, res) => {
  const body = req.body || {};
  // Accept only known boolean fields; ignore others
  ['emailEnabled','dashboardAlertsEnabled','aiPriorityTaggingEnabled','escalationEnabled'].forEach(k => {
    if (typeof body[k] === 'boolean') alertSettings[k] = body[k];
  });
  alertSettings.lastUpdated = new Date().toISOString();
  res.json({ ok: true, success: true, status: 200, data: alertSettings });
});

module.exports = router;
