const express = require('express');

const {
  listPublicNews,
  getPublicNewsBySlugOrId,
} = require('../controllers/publicNewsController');

const router = express.Router();

// Public read-only news feed (NO AUTH)
// GET /api/public/news
router.get('/', listPublicNews);

// GET /api/public/news/:slugOrId
router.get('/:slugOrId', getPublicNewsBySlugOrId);

module.exports = router;
