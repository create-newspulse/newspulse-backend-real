const express = require('express');
const { getMailerStatus, getTransporter } = require('./../lib/mailer');

// Router used by NewsPulse Admin Panel to silence AI helper + monitor probes
const router = express.Router();

// GET /health → will be mounted under /api/system and /system and /api/admin/system
router.get('/health', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    service: 'newspulse-backend',
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    data: {
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV || 'development',
    },
  });
});

// GET /ai-health → stable 200 for admin panel (even when AI is not configured)
router.get('/ai-health', (_req, res) => {
  return res.status(200).json({
    ok: true,
    success: true,
    aiEnabled: false,
    message: 'AI command not configured',
    data: { status: 'ok' },
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

// GET /email-status -> safe mailer diagnostics for direct backend verification
router.get('/email-status', (_req, res) => {
  const status = getMailerStatus();
  let transporterReady = false;
  let transporterError = null;

  try {
    const transport = getTransporter();
    transporterReady = !!transport;
  } catch (error) {
    transporterReady = false;
    transporterError = error?.message || String(error);
  }

  return res.status(200).json({
    ok: true,
    success: true,
    mailer: {
      productionLike: status.productionLike,
      renderLike: status.renderLike,
      stubMode: status.stubMode,
      configured: status.configured,
      missing: status.missing,
      resolved: status.resolved,
      transporterReady,
      transporterError,
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
