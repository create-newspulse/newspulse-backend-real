const express = require('express');

const {
  postArticleView,
  postArticleEngagement,
  postArticleScroll,
  postArticleHeartbeat,
} = require('../controllers/articleAnalyticsController');

const router = express.Router();

router.post('/discovery', express.json({ limit: '4kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json({ ok: true, ...await require('../services/discoveryAnalytics.service').ingestDiscovery(req, req.body) });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ ok: false, message: error.message });
    return res.json({ ok: true, skipped: true, reason: 'unavailable' });
  }
});

// Public-safe ingestion endpoints
router.post('/article/view', postArticleView);
router.post('/article/engagement', postArticleEngagement);
router.post('/article/scroll', postArticleScroll);
router.post('/article/heartbeat', postArticleHeartbeat);

module.exports = router;
