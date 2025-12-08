const express = require('express');
const { submitStory, listStoriesByReporter } = require('../controllers/communityReporterController');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

router.post('/submit', submitStory);
router.get('/my-stories', listStoriesByReporter);

// Admin Queue: GET /api/community-reporter/queue?status=pending
router.get('/queue', requireAdminAuth, async (req, res) => {
	try {
		const status = (req.query.status || 'pending').toString();
		const page = Math.max(parseInt(req.query.page || '1', 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
		const skip = (page - 1) * limit;

		const mapStatus = (s) => {
			const key = s.toLowerCase();
			if (key === 'pending' || key === 'under_review') return ['PENDING_FOUNDER', 'UNDER_REVIEW', 'NEW', 'pending', 'under_review'];
			if (key === 'approved') return ['APPROVED', 'approved'];
			if (key === 'rejected') return ['REJECTED', 'rejected'];
			return [s];
		};

		const filter = { };
		if (status && status !== 'all') {
			filter.status = { $in: mapStatus(status) };
		}

		const [docs, total] = await Promise.all([
			CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
			CommunitySubmission.countDocuments(filter),
		]);

		const data = docs.map(d => ({
			id: d._id.toString(),
			headline: d.headline || '',
			category: d.category || null,
			reporter: (d.contact && d.contact.name) || d.reporterName || d.name || 'Unknown',
			location: d.location?.city || d.city || null,
			priority: d.priority || 'normal',
			aiRisk: typeof d.riskScore === 'number' ? d.riskScore : null,
			status: d.status || 'under_review',
			createdAt: d.createdAt || null,
		}));

		return res.status(200).json({
			ok: true,
			success: true,
			status: 200,
			data,
			meta: { statusFilter: status, total, page, limit },
			message: 'Community reporter queue',
		});
	} catch (e) {
		console.error('[community-reporter][queue][nested] error', e?.message || e);
		return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
	}
});

module.exports = router;
