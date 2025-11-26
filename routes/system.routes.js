const express = require('express');

// Router used by NewsPulse Admin Panel to silence AI helper + monitor probes
const router = express.Router();

// POST /api/assist/suggest/v2 → stub suggestions
router.post('/assist/suggest/v2', (req, res) => {
  return res.json({ ok: true, success: true, suggestions: [] });
});

// GET /api/system/monitor-hub → health stub
router.get('/system/monitor-hub', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 'healthy',
    services: {
      api: 'up',
      db: 'up',
    },
  });
});

module.exports = router;
