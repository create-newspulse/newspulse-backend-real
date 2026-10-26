// const express = require('express');
// const router = express.Router();
// const { createNews, getNews } = require('../controllers/newsController');

// router.post('/news', createNews);
// router.get('/news', getNews);

// module.exports = router;

const express = require('express');
const router = express.Router();
const { createNews, getNews, updateNews, getPublishedNewsBySlug } = require('../controllers/newsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

// Primary root path so mounted at /api/news gives /api/news (list/create)
router.route('/').post(requireAdminAuth, createNews).get(getNews);
// Backward compatibility path (legacy double /news/news)
router.route('/news').post(requireAdminAuth, createNews).get(getNews);

// Compatibility: lookup published news by slug (unicode-safe)
router.get('/slug/:slug', getPublishedNewsBySlug);

// Authenticated legacy update compatibility.
router.route('/:id').put(requireAdminAuth, updateNews).patch(requireAdminAuth, updateNews);

module.exports = router;
