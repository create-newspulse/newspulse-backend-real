const express = require('express');
const { requireAuth, requireModuleAccess, requireSpecialRight } = require('../middleware/requireAuth');
const { normalizeRole } = require('../lib/teamAccess');
const curation = require('../services/pulseDialogueCuration.service');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => ['founder', 'editor'].includes(normalizeRole(req.user?.role))
  ? next() : res.status(403).json({ ok: false, message: 'Founder or editorial access required' }));
router.use(requireModuleAccess('manage_news'), requireSpecialRight('news_publish'));

function handle(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ ok: true, configuration: await handler(req) }); }
    catch (error) {
      return res.status(error.statusCode === 400 ? 400 : 503).json({ ok: false,
        message: error.statusCode === 400 ? error.message : 'Pulse Dialogue curation unavailable' });
    }
  };
}

router.get('/', handle(() => curation.getAdminConfiguration()));
router.put('/featured-dialogue', handle(req => curation.setList('featuredDialogue', req.body)));
router.put('/featured-voices', handle(req => curation.setList('featuredVoices', req.body)));
module.exports = router;