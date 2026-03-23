const express = require('express');

const {
  postArticleView,
  postArticleEngagement,
  postArticleScroll,
  postArticleHeartbeat,
} = require('../controllers/articleAnalyticsController');

const router = express.Router();

// Public-safe ingestion endpoints
router.post('/article/view', postArticleView);
router.post('/article/engagement', postArticleEngagement);
router.post('/article/scroll', postArticleScroll);
router.post('/article/heartbeat', postArticleHeartbeat);

module.exports = router;
