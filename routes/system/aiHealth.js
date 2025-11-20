const express = require('express');
const router = express.Router();

// Simple AI subsystem health probe
// Mounted at /system/ai-health and /api/system/ai-health
router.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'ai-health',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

module.exports = router;
