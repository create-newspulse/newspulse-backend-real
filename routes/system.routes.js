const express = require('express');

// Router used by NewsPulse Admin Panel to silence AI helper + monitor probes
const router = express.Router();

// POST /api/assist/suggest/v2 → stub suggestions
router.post('/assist/suggest/v2', (req, res) => {
  return res.json({ ok: true, success: true, suggestions: [] });
});

// GET /monitor-hub → will be mounted under /api/system and /system
router.get('/monitor-hub', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'System monitor status',
    data: {
      publishRuntime: { envDefault: false, override: false, effective: false },
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV || 'development',
    },
  });
});

module.exports = router;
