const express = require('express');

const {
  listPublicNews,
  listPublicNewsTranslations,
  getPublicNewsBySlugOrId,
  getPublicNewsBySlug,
} = require('../controllers/publicNewsController');

const router = express.Router();

// Public read-only news feed (NO AUTH)
// GET /api/public/news
router.get('/', listPublicNews);

// GET /api/public/news/translations/:translationGroupId
router.get('/translations/:translationGroupId', listPublicNewsTranslations);

// GET /api/public/news/slug/:slug
router.get('/slug/:slug', getPublicNewsBySlug);

// GET /api/public/news/:slugOrId
router.get('/:slugOrId', getPublicNewsBySlugOrId);

module.exports = router;
