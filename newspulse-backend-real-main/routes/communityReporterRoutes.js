const express = require('express');
const { submitStory, listStoriesByReporter } = require('../controllers/communityReporterController');
const { requireAdminAuth } = require('../../middleware/adminAuth');

const router = express.Router();

router.post('/submit', submitStory);
router.get('/my-stories', listStoriesByReporter);

// Admin Queue: GET /api/community-reporter/queue?status=pending
router.get('/queue', requireAdminAuth, async (req, res) => {
	try {
		const status = (req.query.status || 'pending').toString();
		return res.status(200).json({
			ok: true,
			success: true,
			status: 200,
			data: [],
			meta: { statusFilter: status, total: 0 },
			message: 'Community reporter queue (placeholder)',
		});
	} catch (e) {
		console.error('[community-reporter][queue][nested] error', e?.message || e);
		return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
	}
});

module.exports = router;
