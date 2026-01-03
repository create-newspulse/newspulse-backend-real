const express = require('express');
const router = express.Router();

// When mounted at /system/ai-training-info, respond at the root
router.get('/', (_req, res) => {
  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI training info',
    data: {
      mode: 'online',
      lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString(),
      notes: 'Admin panel using unified backend.',
    },
  });
});

module.exports = router;
