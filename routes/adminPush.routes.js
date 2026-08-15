const express = require('express');

const { requireFounderAuth, requireFounderOrAdmin } = require('../middleware/adminAuth');
const {
  getPushFirebaseStatus,
  getPushDiagnostics,
  getPushHistory,
  sendTestPush,
  sendLatestTestPush,
  sendBreakingPush,
  sendArticlePush,
} = require('../controllers/pushRegistrationController');

const router = express.Router();

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_PUSH_SEND_LIMIT = 30;
const adminPushSendBuckets = new Map();

function getClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function adminPushSendRateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.method}:${req.path}:${getClientKey(req)}`;
  const bucket = adminPushSendBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    adminPushSendBuckets.set(key, { windowStart: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > ADMIN_PUSH_SEND_LIMIT) {
    return res.status(429).json({ ok: false, success: false, status: 429, code: 'RATE_LIMITED', message: 'Too many push send requests' });
  }
  return next();
}

router.get('/status', requireFounderAuth, getPushFirebaseStatus);
router.get('/diagnostics', requireFounderOrAdmin, getPushDiagnostics);
router.get('/history', requireFounderOrAdmin, getPushHistory);
router.post('/test', requireFounderAuth, sendTestPush);
router.post('/test-latest', requireFounderOrAdmin, sendLatestTestPush);
router.post('/breaking', requireFounderOrAdmin, adminPushSendRateLimit, sendBreakingPush);
router.post('/article', requireFounderOrAdmin, adminPushSendRateLimit, sendArticlePush);

module.exports = router;