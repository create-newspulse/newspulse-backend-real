// Public + Admin community settings controller (admin wrapper)
// Re-export admin handlers and add public-safe handler here for clarity.

const { getEffectiveCommunityAccessState } = require('../../services/communityAccessToggleService');

async function getPublicCommunitySettings(req, res) {
	try {
		const state = await getEffectiveCommunityAccessState();
		res.set('Cache-Control', 'no-store, max-age=0');
		res.set('Pragma', 'no-cache');
		res.set('Expires', '0');
		const settings = {
			communityReporterEnabled: state.communityReporterEnabled,
			reporterPortalEnabled: state.reporterPortalEnabled,
			allowNewSubmissions: state.allowNewSubmissions,
			allowMyStoriesPortal: state.allowMyStoriesPortal,
			allowJournalistApplications: state.allowJournalistApplications,
			safeModeManualReviewOnly: state.safeModeManualReviewOnly,
			communityReporterClosed: state.communityReporterClosed,
			reporterPortalClosed: state.reporterPortalClosed,
			communityMyStoriesEnabled: state.communityMyStoriesEnabled,
		};
		return res.json({
			ok: true,
			settings,
			featureToggles: {
				communityReporterClosed: state.communityReporterClosed,
				reporterPortalClosed: state.reporterPortalClosed,
			},
		});
	} catch (err) {
		console.error('getPublicCommunitySettings error', err);
		res.set('Cache-Control', 'no-store, max-age=0');
		res.set('Pragma', 'no-cache');
		res.set('Expires', '0');
		return res.status(200).json({
			ok: true,
			settings: {
				communityReporterEnabled: true,
				reporterPortalEnabled: true,
				allowNewSubmissions: true,
				allowMyStoriesPortal: true,
				allowJournalistApplications: true,
				safeModeManualReviewOnly: false,
				communityReporterClosed: false,
				reporterPortalClosed: false,
				communityMyStoriesEnabled: true,
			},
			featureToggles: {
				communityReporterClosed: false,
				reporterPortalClosed: false,
			},
		});
	}
}

const admin = require('../communitySettingsController');

module.exports = {
	getAdminCommunitySettings: admin.getAdminCommunitySettings,
	patchAdminCommunitySettings: admin.patchAdminCommunitySettings,
	getPublicCommunitySettings,
};