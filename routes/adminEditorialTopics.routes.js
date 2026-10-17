const express = require('express');
const { requireFounderOnly, requireAdminModule } = require('../middleware/adminAuth');
const { requireSpecialRight } = require('../middleware/requireAuth');
const noCache = require('../middleware/noCache');
const topics = require('../services/editorialTopics.service');
const stories = require('../services/editorialTopicStories.service');

const router = express.Router();
router.use(noCache);
const editorialAccess = requireAdminModule('manage_news');
const editAccess = requireSpecialRight('news_edit');

router.get('/available', editorialAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.listAvailableTopics(req.query) });
}));

router.get('/:id/stories', editorialAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.listAttachedStories(req.params.id, req.query) });
}));

router.get('/:id/stories/search', editorialAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.searchTopicStories(req.params.id, req.query) });
}));

router.get('/:id/candidates', editorialAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.discoverCandidateStories(req.params.id, req.query) });
}));

router.post('/:id/stories/attach', editorialAccess, editAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.attachStories(req.params.id, req.body) });
}));

router.post('/:id/stories/detach', editorialAccess, editAccess, topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await stories.detachStories(req.params.id, req.body) });
}));

router.use(requireFounderOnly);

router.get('/', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, ...await topics.listAdminTopics(req.query) });
}));

router.post('/', topics.handleTopicRequest(async (req, res) => {
  return res.status(201).json({ ok: true, topic: await topics.createTopic(req.body, req.admin) });
}));

router.get('/:id', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, topic: await topics.getAdminTopic(req.params.id) });
}));

router.patch('/:id', topics.handleTopicRequest(async (req, res) => {
  return res.json({ ok: true, topic: await topics.updateTopic(req.params.id, req.body, req.admin) });
}));

module.exports = router;
