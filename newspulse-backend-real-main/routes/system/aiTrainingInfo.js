const express = require('express');
const router = express.Router();

// When mounted at /system/ai-training-info, respond at the root
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'online',
    lastUpdated: new Date().toISOString(),
    notes: 'Admin panel using unified backend.',
  });
});

module.exports = router;
