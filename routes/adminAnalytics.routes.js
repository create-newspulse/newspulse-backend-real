const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getDashboard,
  listArticles,
  getArticleDetails,
  listCategories,
} = require('../controllers/adminAnalyticsController');

const router = express.Router();

// Admin-only analytics endpoints
router.get('/dashboard', requireAdminAuth, getDashboard);
router.get('/articles', requireAdminAuth, listArticles);
router.get('/articles/:articleId', requireAdminAuth, getArticleDetails);
router.get('/categories', requireAdminAuth, listCategories);

module.exports = router;
