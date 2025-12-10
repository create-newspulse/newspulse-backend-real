const express = require('express');

// Router used by NewsPulse Admin Panel to silence AI helper + monitor probes
const router = express.Router();

// GET /health → will be mounted under /api/system and /system and /api/admin/system
router.get('/health', (req, res) => {
  return res.json({
    ok: true,
    env: 'admin',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    status: 'ok',
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

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

// POST /system/ai-command → stubbed for local dev
router.post('/ai-command', (req, res) => {
  return res.json({
    ok: true,
    message: 'AI Command endpoint stubbed for local dev.',
    received: req.body ?? null,
  });
});

module.exports = router;
