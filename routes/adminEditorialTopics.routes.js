const express = require('express');
const { requireFounderOnly } = require('../middleware/adminAuth');
const noCache = require('../middleware/noCache');
const topics = require('../services/editorialTopics.service');

const router = express.Router();
router.use(noCache, requireFounderOnly);

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
