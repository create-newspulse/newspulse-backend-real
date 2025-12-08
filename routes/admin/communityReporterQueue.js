const express = require('express');
const { requireAdminAuth } = require('../../middleware/adminAuth');

const router = express.Router();

// GET /community-reporter/queue (mounted under /api/admin and aliases)
router.get('/community-reporter/queue', requireAdminAuth, async (req, res) => {
  try {
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: [],
      message: 'Community reporter queue (placeholder)',
    });
  } catch (e) {
    console.error('[admin][community-reporter/queue] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
  }
});

module.exports = router;
