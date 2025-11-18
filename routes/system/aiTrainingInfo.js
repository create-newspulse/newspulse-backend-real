const express = require('express');
const router = express.Router();

// When mounted at /api/system/ai-training-info, respond at the root
router.get('/', (_req, res) => {
  res.json({ ok: true, engines: ['openai', 'gemini'], lastUpdated: new Date().toISOString() });
});

module.exports = router;
