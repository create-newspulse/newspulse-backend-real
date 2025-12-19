const express = require('express');
const FounderFeatureToggles = require('../../models/FounderFeatureToggles');
const { requireAdminAuth, requireFounderAuth } = require('../../middleware/adminAuth');
const { requireOwnerKey } = require('../../middleware/requireOwnerKey');

const router = express.Router();

async function getOrCreateToggles() {
	return FounderFeatureToggles.findOneAndUpdate(
		{ key: "community_feature_toggles" },
		{
			$setOnInsert: {
				key: "community_feature_toggles",
				communityReporterClosed: false,
				reporterPortalClosed: false,
			},
		},
		{ new: true, upsert: true }
	).lean();
}

router.get('/feature-toggles', requireAdminAuth, async (req, res) => {
	const doc = await getOrCreateToggles();
	res.set('Cache-Control', 'no-store');
	res.json({
		communityReporterClosed: !!doc.communityReporterClosed,
		reporterPortalClosed: !!doc.reporterPortalClosed,
		updatedAt: doc.updatedAt,
	});
});

router.patch('/feature-toggles', requireAdminAuth, async (req, res) => {
	// Owner-key unlock required for state-changing operations
	return requireFounderAuth(req, res, async () => {
		return requireOwnerKey(req, res, async () => {
	const { communityReporterClosed, reporterPortalClosed } = req.body || {};
	const update = {};
	if (typeof communityReporterClosed === "boolean") update.communityReporterClosed = communityReporterClosed;
	if (typeof reporterPortalClosed === "boolean") update.reporterPortalClosed = reporterPortalClosed;

	const doc = await FounderFeatureToggles.findOneAndUpdate(
		{ key: 'community_feature_toggles' },
		{ $set: update, $setOnInsert: { key: 'community_feature_toggles' } },
		{ new: true, upsert: true }
	).lean();

	res.set('Cache-Control', 'no-store');
	res.json({
		communityReporterClosed: !!doc.communityReporterClosed,
		reporterPortalClosed: !!doc.reporterPortalClosed,
		updatedAt: doc.updatedAt,
	});
		});
	});
});

module.exports = router;
