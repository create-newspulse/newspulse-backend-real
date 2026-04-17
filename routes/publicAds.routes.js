const express = require('express');
const mongoose = require('mongoose');

const noCache = require('../middleware/noCache');
const { createJsonCacheMiddleware, buildAdsCacheKey } = require('../lib/cache');

const {
  getActiveAd,
  postImpression,
  postClick,
} = require('../controllers/publicAdsController');

const router = express.Router();

router.use(noCache);

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  // Lightweight email validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// GET /api/public/ads?slot=HOME_728x90
router.get('/ads', createJsonCacheMiddleware({
  ttlSeconds: 60,
  buildKey: (req) => {
    if (!isDbReady()) return null;
    const slot = req.query && req.query.slot ? String(req.query.slot) : '';
    return slot ? buildAdsCacheKey(slot) : null;
  },
  shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Object.prototype.hasOwnProperty.call(body, 'ad'),
}), getActiveAd);

// GET /api/public/ads/slot/:slot
router.get('/ads/slot/:slot', createJsonCacheMiddleware({
  ttlSeconds: 60,
  buildKey: (req) => {
    if (!isDbReady()) return null;
    return req.params && req.params.slot ? buildAdsCacheKey(req.params.slot) : null;
  },
  shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Object.prototype.hasOwnProperty.call(body, 'ad'),
}), (req, res, next) => {
  req.query = req.query || {};
  req.query.slot = req.params.slot;
  return getActiveAd(req, res, next);
});

// POST /api/public/ads/:id/impression
router.post('/ads/:id/impression', postImpression);

// POST /api/public/ads/:id/click
router.post('/ads/:id/click', postClick);

module.exports = router;
