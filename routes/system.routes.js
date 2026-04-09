const express = require('express');
const {
  classifyAndWrapMailerError,
  DEFAULT_MAIL_SCOPE,
  getMailerStatus,
  getTransporter,
  REPORTER_OTP_MAIL_SCOPE,
} = require('./../lib/mailer');

// Router used by NewsPulse Admin Panel to silence AI helper + monitor probes
const router = express.Router();

function buildMailerDiagnostics(scope) {
  const status = getMailerStatus({ scope });
  let transporterReady = false;
  let transporterError = null;
  let backendCode = status.configured ? null : 'MAILER_NOT_CONFIGURED';

  try {
    const transport = getTransporter(undefined, { scope });
    transporterReady = !!transport;
  } catch (error) {
    const classified = classifyAndWrapMailerError(error, { provider: status.provider, scope });
    transporterReady = false;
    transporterError = classified?.message || error?.message || String(error);
    backendCode = classified?.backendCode || 'PROVIDER_UNAVAILABLE';
  }

  return {
    scope: status.scope,
    productionLike: status.productionLike,
    renderLike: status.renderLike,
    stubMode: status.stubMode,
    provider: status.provider,
    providerOrder: status.providerOrder,
    fallbackProvider: status.fallbackProvider,
    configured: status.configured,
    backendCode,
    missing: status.missing,
    resolved: status.resolved,
    transport: status.transport,
    transporterReady,
    transporterError,
  };
}

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
router.get('/email-status', (req, res) => {
  const requestedScope = String(req.query?.scope || '').trim().toLowerCase();
  if (requestedScope === REPORTER_OTP_MAIL_SCOPE || requestedScope === DEFAULT_MAIL_SCOPE) {
    return res.status(200).json({
      ok: true,
      success: true,
      mailer: buildMailerDiagnostics(requestedScope),
    });
  }

  return res.status(200).json({
    ok: true,
    success: true,
    mailer: buildMailerDiagnostics(DEFAULT_MAIL_SCOPE),
    reporterMailer: buildMailerDiagnostics(REPORTER_OTP_MAIL_SCOPE),
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
