const express = require('express');

const { getCloudinaryConfigStatus } = require('../lib/cloudinary');
const { optionalAdminAuth } = require('../middleware/optionalAdminAuth');
const { shouldLog } = require('../lib/logThrottle');

const router = express.Router();

const PROVIDER = 'cloudinary';

function sendStableStatus(res, payload) {
  const ok = true;
  const provider = PROVIDER;
  const available = Boolean(payload && payload.available);
  const reason = available ? null : String((payload && payload.reason) || 'Media upload status unavailable');
  const configured = Boolean(payload && payload.configured);
  const message = String((payload && payload.message) || (available ? 'Media uploads are ready' : reason));

  return res.status(200).json({
    ok,
    provider,
    available,
    reason,
    configured,
    message,
  });
}

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
    console.log('[media.status] hit', { path, method, origin, authOutcome, role: req.admin?.role || null });
  }

  try {
    const st = getCloudinaryConfigStatus();
    const configured = !!st.configured;
    const available = configured;
    const reason = available ? null : 'Cloudinary not configured';

    if (shouldLog(`media.status:resp:${authOutcome}:${available ? 'yes' : 'no'}`, 60_000)) {
      // eslint-disable-next-line no-console
      console.log('[media.status] response', {
        path,
        method,
        origin,
        authOutcome,
        configured,
        available,
        reason,
        mode: st.mode,
        missing: st.missing,
        cloudinaryUrlValid: st.cloudinaryUrlValid,
        env: st.env,
      });
    }

    return sendStableStatus(res, {
      available,
      reason,
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

    return sendStableStatus(res, {
      available: false,
      reason: 'Media upload status unavailable',
      configured: false,
      message: 'Cloudinary status unavailable',
    });
  }
});

module.exports = router;
