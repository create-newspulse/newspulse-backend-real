const express = require('express');

const {
  registerPush,
  recordPushReceipt,
  updatePushPreferences,
  unregisterPush,
  getPushDiagnostics,
} = require('../controllers/pushRegistrationController');

const router = express.Router();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_MUTATION_RATE_LIMIT_MAX = 90;
const PUBLIC_RECEIPT_RATE_LIMIT_MAX = 240;
const BODY_LIMIT_BYTES = 16 * 1024;
const buckets = new Map();

function getClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function requireSmallBody(req, res, next) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT_BYTES) {
    return res.status(413).json({ ok: false, success: false, status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' });
  }
  return next();
}

function rateLimit(maxRequests) {
  return function publicPushRateLimit(req, res, next) {
    const now = Date.now();
    const key = `${req.method}:${req.path}:${getClientKey(req)}`;
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      buckets.set(key, { windowStart: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ ok: false, success: false, status: 429, code: 'RATE_LIMITED', message: 'Too many requests' });
    }
    return next();
  };
}

router.use(requireSmallBody);

router.get('/diagnostics', getPushDiagnostics);
router.post('/register', rateLimit(PUBLIC_MUTATION_RATE_LIMIT_MAX), registerPush);
router.post('/receipt', rateLimit(PUBLIC_RECEIPT_RATE_LIMIT_MAX), recordPushReceipt);
router.put('/preferences', rateLimit(PUBLIC_MUTATION_RATE_LIMIT_MAX), updatePushPreferences);
router.delete('/unregister', rateLimit(PUBLIC_MUTATION_RATE_LIMIT_MAX), unregisterPush);
router.post('/unregister', rateLimit(PUBLIC_MUTATION_RATE_LIMIT_MAX), unregisterPush);

module.exports = router;