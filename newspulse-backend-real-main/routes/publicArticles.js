const express = require('express');
const { listArticles, getArticleBySlug } = require('../controllers/publicArticlesController');

const router = express.Router();

// GET /api/articles
router.get('/', listArticles);

// GET /api/articles/:slug
router.get('/:slug', getArticleBySlug);

module.exports = router;
