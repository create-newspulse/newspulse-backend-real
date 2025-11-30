const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// Placeholder admin community-reporter routes to ensure server boots.
// Keep responses minimal; real implementations can extend these.
router.get('/submissions', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    return res.json({ ok: true, items: [], total: 0, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][submissions] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});

module.exports = router;
