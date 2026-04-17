const express = require('express');
const mongoose = require('mongoose');
const { createJsonCacheMiddleware, buildLatestCacheKey, buildCategoryCacheKey, normalizeCacheLang } = require('../lib/cache');
const noCache = require('../middleware/noCache');

const {
  listPublicNews,
  listPublicNewsTranslations,
  getPublicNewsByTranslationKey,
  getPublicNewsBySlugOrId,
  getPublicNewsBySlug,
  translatePublicNews,
} = require('../controllers/publicNewsController');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function getRequestedLang(req) {
  return normalizeCacheLang(
    req.query.lang || req.query.language || req.headers['x-lang'] || req.headers['x-language'] || req.lang || 'gu',
    'gu'
  );
}

function buildPublicNewsCacheKey(req) {
  if (!isDbReady()) return null;

  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const category = String(req.query.category || '').trim();
  const track = String(req.query.track || '').trim();
  const topic = String(req.query.topic || '').trim();
  const state = String(req.query.state || req.query.locationState || '').trim();
  const founderOnly = String(req.query.founderOnly || '').trim();
  const type = String(req.query.type || '').trim();
  const q = String(req.query.q || '').trim();
  const lang = getRequestedLang(req);

  if (category) {
    return buildCategoryCacheKey(category, lang, page);
  }

  if (page !== 1 || track || topic || state || founderOnly || type || q) {
    return null;
  }

  return buildLatestCacheKey(lang);
}

// Public read-only news feed (NO AUTH)
// GET /api/public/news
router.get(
  '/',
  noCache,
  createJsonCacheMiddleware({
    ttlSeconds: 45,
    buildKey: buildPublicNewsCacheKey,
    shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Array.isArray(body.items),
  }),
  listPublicNews,
);

// GET /api/public/news/translations/:translationGroupId
router.get('/translations/:translationGroupId', listPublicNewsTranslations);

// GET /api/public/news/translation?translationKey=...&lang=...
router.get('/translation', getPublicNewsByTranslationKey);

// GET /api/public/news/slug/:slug
router.get('/slug/:slug', getPublicNewsBySlug);

// POST /api/public/news/:id/translate
router.post('/:id/translate', translatePublicNews);

// GET /api/public/news/:slugOrId
router.get('/:slugOrId', getPublicNewsBySlugOrId);

module.exports = router;
