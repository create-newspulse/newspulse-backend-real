const express = require('express');
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const {
  createJsonCacheMiddleware,
  buildLatestCacheKey,
  buildCategoryCacheKey,
  normalizeCategorySlugForCache,
} = require('../lib/cache');
const { setRequestTimingCacheContext } = require('../lib/timingDiagnostics');
const noCache = require('../middleware/noCache');

const {
  resolvePublicNewsListRequest,
  listPublicBreakingNews,
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

function buildPublicNewsCacheKey(req) {
  if (!isDbReady()) return null;
  const { page, limit, category, track, topic, state, founderOnly, type, desired: lang, fallbackEnabled, q } = resolvePublicNewsListRequest(req);
  if (!Number.isSafeInteger(page) || !Number.isFinite(limit) || (req.query.track !== undefined && !track)) return null;
  const variant = createHash('sha256').update(JSON.stringify({
    limit,
    track,
    topic,
    state: state ? state.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : null,
    q: q.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
    founderOnly,
    type: type === 'video' ? 'video' : '',
    fallback: category ? false : fallbackEnabled,
  })).digest('hex');

  if (category) {
    const cacheKey = `${buildCategoryCacheKey(category, lang, page)}:v2:${variant}`;
    setRequestTimingCacheContext(req, {
      cacheFamily: 'category',
      cacheKey,
      language: lang,
      category: normalizeCategorySlugForCache(category),
      page,
    });
    return cacheKey;
  }

  if (page !== 1 || track || topic || state || founderOnly || type || q) {
    return null;
  }

  const cacheKey = `${buildLatestCacheKey(lang)}:v2:${variant}`;
  setRequestTimingCacheContext(req, {
    cacheFamily: 'latest',
    cacheKey,
    language: lang,
  });
  return cacheKey;
}

// Public read-only news feed (NO AUTH)
// GET /api/public/news
router.get(
  '/',
  noCache,
  createJsonCacheMiddleware({
    publicNewsDiagnostics: true,
    ttlSeconds: 45,
    staleWhileRevalidate: true,
    backgroundRebuild: listPublicNews,
    deterministicTtlSpreadSeconds: 15,
    rebuildConcurrencyGroup: 'public-news',
    rebuildConcurrencyLimit: 2,
    lockTtlSeconds: 60,
    onRebuildUnavailable: (req, res) => res.status(503).json({
      items: [],
      page: Math.max(parseInt(req.query.page || '1', 10) || 1, 1),
      limit: Math.min(Math.max(parseInt(req.query.limit || '30', 10) || 30, 1), 100),
      total: 0,
      totalPages: 1,
      message: 'News feed is busy. Please retry shortly.',
    }),
    buildKey: buildPublicNewsCacheKey,
    shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Array.isArray(body.items),
  }),
  listPublicNews,
);

// GET /api/public/news/breaking
router.get('/breaking', noCache, listPublicBreakingNews);

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
