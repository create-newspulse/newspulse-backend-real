// routes/system.js
// Small health + AI debug endpoints for the Admin Dashboard UI.

const express = require('express');
const cors = require('cors');
const router = express.Router();

// Router-level CORS to ensure /system/* works cross-origin
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://admin.newspulse.co.in',
  'https://newspulse.co.in',
];
router.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);

// GET /system/health  (and /api/system/health via server.js mounting)
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'newspulse-backend',
    uptimeSeconds: parseFloat(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
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