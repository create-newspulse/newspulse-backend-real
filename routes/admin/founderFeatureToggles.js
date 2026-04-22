const express = require('express');
const { requireFounderAuth } = require('../../middleware/adminAuth');
const {
	getEffectiveCommunityAccessState,
	getFounderToggleDoc,
	updateFounderToggles,
} = require('../../services/communityAccessToggleService');
const {
	getDefaultFounderFeatureToggles,
	extractFeatureTogglePatch,
} = require('../../services/founderCommandService');

function formatFeatureToggleResponse(data) {
	const payload = {
		communityReporterClosed: !!data?.communityReporterClosed,
		reporterPortalClosed: !!data?.reporterPortalClosed,
		youthPulseSubmissionsClosed: !!data?.youthPulseSubmissionsClosed,
		communityReporterEnabled: data?.communityReporterEnabled !== false,
		reporterPortalEnabled: data?.reporterPortalEnabled !== false,
		youthPulseSubmissionsEnabled: data?.youthPulseSubmissionsEnabled !== false,
		updatedAt: data?.updatedAt || null,
	};
	return {
		...payload,
		ok: true,
		success: true,
		status: 200,
		data: payload,
		settings: payload,
	};
}

async function saveFeatureToggles(req, res) {
	try {
		const patch = extractFeatureTogglePatch(req.body || {});
		const doc = await updateFounderToggles(patch);
		const effective = await getEffectiveCommunityAccessState();

		res.set('Cache-Control', 'no-store');
		return res.json(formatFeatureToggleResponse({
			communityReporterClosed: !!doc?.communityReporterClosed,
			reporterPortalClosed: !!doc?.reporterPortalClosed,
			youthPulseSubmissionsClosed: !!doc?.youthPulseSubmissionsClosed,
			communityReporterEnabled: effective.communityReporterEnabled,
			reporterPortalEnabled: effective.reporterPortalEnabled,
			youthPulseSubmissionsEnabled: effective.youthPulseSubmissionsEnabled,
			updatedAt: effective.updatedAt,
		}));
	} catch (err) {
		console.error('[FOUNDER_FEATURE_TOGGLES][patch] failed', err?.stack || err?.message || err);
		return res.status(500).json({
			ok: false,
			success: false,
			status: 500,
			message: 'Internal error',
			path: req.originalUrl,
		});
	}
}

const router = express.Router();

router.get('/feature-toggles', requireFounderAuth, async (req, res) => {
	try {
		const doc = await getFounderToggleDoc({ createIfMissing: true });
		const effective = await getEffectiveCommunityAccessState();
		res.set('Cache-Control', 'no-store');
		res.json(formatFeatureToggleResponse({
			communityReporterClosed: !!doc?.communityReporterClosed,
			reporterPortalClosed: !!doc?.reporterPortalClosed,
			youthPulseSubmissionsClosed: !!doc?.youthPulseSubmissionsClosed,
			communityReporterEnabled: effective.communityReporterEnabled,
			reporterPortalEnabled: effective.reporterPortalEnabled,
			youthPulseSubmissionsEnabled: effective.youthPulseSubmissionsEnabled,
			updatedAt: effective.updatedAt,
		}));
	} catch (err) {
		console.error('[FOUNDER_FEATURE_TOGGLES][get] failed', err?.stack || err?.message || err);
		const fallback = await getDefaultFounderFeatureToggles();
		res.set('Cache-Control', 'no-store');
		return res.status(200).json(formatFeatureToggleResponse(fallback));
	}
});

router.patch('/feature-toggles', requireFounderAuth, saveFeatureToggles);
router.put('/feature-toggles', requireFounderAuth, saveFeatureToggles);

module.exports = router;
