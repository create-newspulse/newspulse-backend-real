const express = require('express');
const noCache = require('../middleware/noCache');
const topics = require('../services/editorialTopics.service');

const router = express.Router();
router.use(noCache);

router.get('/', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await topics.listPublicTopics(req.query) });
}));

router.get('/:slug/articles', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await topics.listTopicStories(req.params.slug, req.query) });
}));

router.get('/:slug', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await topics.getPublicTopic(req.params.slug, req.query) });
}));

module.exports = router;
