const express = require('express');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const { getCommunityReporterQueue } = require('../../controllers/communityReporterController');

const router = express.Router();

// GET /community-reporter/queue (mounted under /api/admin and aliases)
router.get('/community-reporter/queue', requireAdminAuth, async (req, res) => {
  try {
    // Reuse public controller logic but adapt shape to { items: [...] }
    const mockRes = {
      status: (code) => ({
        json: (payload) => ({ code, payload }),
      }),
      json: (payload) => ({ code: 200, payload }),
    };
    const result = await getCommunityReporterQueue({ query: req.query }, mockRes);
    // If controller handled response (it returns a payload object in our mock), normalize
    const payload = result && result.payload ? result.payload : null;
    const items = payload && Array.isArray(payload.data) ? payload.data : [];
    const meta = payload && payload.meta ? payload.meta : { statusFilter: String(req.query.status || 'pending') };
    return res.status(200).json({ ok: true, success: true, status: 200, items, meta, message: 'Community reporter queue' });
  } catch (e) {
    console.error('[admin][community-reporter/queue] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
  }
});

module.exports = router;
