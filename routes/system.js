// routes/system.js
// Small health + AI debug endpoints for the Admin Dashboard UI.

const express = require('express');
const router = express.Router();
// Note: CORS is handled globally in server.js. This router remains simple.

// GET /system/health  (and /api/system/health via server.js mounting)
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'newspulse-backend',
    time: new Date().toISOString(),
  });
});

// Optional: stub for the AI training info panel
// GET /system/ai-training-info
router.get('/ai-training-info', (req, res) => {
  res.json({
    ok: true,
    hasData: false,
    totalPromptsLogged: 0,
    lastPromptAt: null,
    notes: 'AI training info logging not implemented yet – this is a safe stub.',
  });
});

// Optional: stub for AI command debug panel
// POST /system/ai-command
router.post('/ai-command', (req, res) => {
  res.json({
    ok: true,
    message:
      'AI command endpoint stub. Backend is reachable, but no real AI action is wired here yet.',
    received: req.body || null,
  });
});

module.exports = router;