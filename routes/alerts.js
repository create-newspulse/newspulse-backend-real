// routes/alerts.js
// Minimal alerts router for Render backend. Safe no-op endpoints.

const express = require('express');
const router = express.Router();

// GET /api/alerts
router.get('/', (_req, res) => {
  res.json({ ok: true, alerts: [] });
});

// POST /api/alerts
router.post('/', (req, res) => {
  const payload = req.body || {};
  res.status(201).json({ ok: true, created: true, payload });
});

module.exports = router;
