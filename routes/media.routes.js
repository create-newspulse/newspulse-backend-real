const express = require('express');

const { getCloudinaryConfigStatus } = require('../lib/cloudinary');
const { optionalAdminAuth } = require('../middleware/optionalAdminAuth');
const { shouldLog } = require('../lib/logThrottle');

const router = express.Router();

// GET /api/media/status
// GET /admin-api/media/status
// Always returns a stable JSON contract for admin clients.
router.get('/status', optionalAdminAuth, (req, res) => {
  const path = req.originalUrl;
  const method = req.method;
  const origin = req.headers.origin || null;

  const authHeader = String(req.headers['authorization'] || '');
  const hasBearer = authHeader.toLowerCase().startsWith('bearer ');
  const cookieHeader = String(req.headers.cookie || '');
  const hasCookie = cookieHeader.includes('np_admin') || cookieHeader.includes('np_admin_token') || cookieHeader.includes('np_admin_access');
  const authAttempted = hasBearer || hasCookie;
  const authOk = !!req.admin;
  const authOutcome = authOk ? 'ok' : authAttempted ? 'invalid' : 'anonymous';

  if (shouldLog(`media.status:hit:${authOutcome}`, 60_000)) {
    // eslint-disable-next-line no-console
    console.log('[media.status] hit', {
      path,
      method,
      origin,
      authOutcome,
      role: req.admin && req.admin.role ? String(req.admin.role) : null,
    });
  }

  try {
    const st = getCloudinaryConfigStatus();
    const configured = !!st.configured;
    const available = configured;
    const reason = available ? null : (st.missing && st.missing.length ? 'Cloudinary not configured' : 'Media upload unavailable');

    if (shouldLog(`media.status:${authOutcome}:${available ? 'available' : 'unavailable'}`, 60_000)) {
      // eslint-disable-next-line no-console
      console.log('[media.status] response', {
        path,
        method,
        origin,
        authOutcome,
        role: req.admin && req.admin.role ? String(req.admin.role) : null,
        configured,
        mode: st.mode,
        missing: st.missing,
        env: st.env,
        available,
        reason,
      });
    }

    return res.status(200).json({
      ok: true,
      provider: 'cloudinary',
      // New stable contract expected by admin clients
      available,
      reason,
      // Backward-compatible fields
      configured,
      message: available ? 'Media uploads are ready' : 'Cloudinary not configured',
    });
  } catch (e) {
    if (shouldLog(`media.status:error:${authOutcome}`, 60_000)) {
      // eslint-disable-next-line no-console
      console.error('[media.status] error', {
        path,
        method,
        origin,
        authOutcome,
        message: e?.message || String(e),
        stack: e?.stack || null,
      });
    }

    return res.status(200).json({
      ok: true,
      provider: 'cloudinary',
      available: false,
      reason: 'Media upload status unavailable',
      // Backward-compatible fields
      configured: false,
      message: 'Cloudinary status unavailable',
    });
  }
});

module.exports = router;
