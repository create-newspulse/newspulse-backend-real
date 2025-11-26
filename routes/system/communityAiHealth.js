const express = require('express');
const router = express.Router();
const { getCommunityAiHealth } = require('../../services/communityAi');

// Reports CommunityAI readiness (env presence) and last invoke status.
router.get('/', (req, res) => {
  try {
    const health = getCommunityAiHealth();
    return res.json({ ok: true, service: 'community-ai', ...health, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(200).json({ ok: true, service: 'community-ai', error: e?.message || String(e), timestamp: new Date().toISOString() });
  }
});

module.exports = router;
