// routes/alerts.js
// Alerts router: provides Smart Alerts settings endpoints used by admin panel.

const express = require('express');
const router = express.Router();

// In-memory settings store (replace with persistent DB later)
let alertSettings = {
  emailEnabled: true,
  dashboardAlertsEnabled: true,
  aiPriorityTaggingEnabled: false,
  escalationEnabled: true,
  lastUpdated: new Date().toISOString(),
};

function requireAdmin(req, res, next) {
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
  next();
}

// GET /api/alerts/settings
router.get('/settings', requireAdmin, (req, res) => {
  res.json({ ok: true, success: true, status: 200, data: alertSettings });
});

// PUT /api/alerts/settings
router.put('/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  // Accept only known boolean fields; ignore others
  ['emailEnabled','dashboardAlertsEnabled','aiPriorityTaggingEnabled','escalationEnabled'].forEach(k => {
    if (typeof body[k] === 'boolean') alertSettings[k] = body[k];
  });
  alertSettings.lastUpdated = new Date().toISOString();
  res.json({ ok: true, success: true, status: 200, data: alertSettings });
});

module.exports = router;
