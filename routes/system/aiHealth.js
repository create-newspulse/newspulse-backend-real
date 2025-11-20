const express = require('express');
const router = express.Router();

// Simple AI health/status endpoint
// Mounted paths will include:
//  - /system/ai-health
//  - /api/system/ai-health
// Returns lightweight JSON suitable for uptime checks.
router.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'ai-health',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;