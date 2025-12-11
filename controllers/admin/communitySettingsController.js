// Public + Admin community settings controller (admin wrapper)
// Re-export admin handlers and add public-safe handler here for clarity.

const CommunityFeatureSettings = require('../../models/CommunityFeatureSettings');

async function getPublicCommunitySettings(req, res) {
	try {
		let doc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();
		if (!doc) {
			doc = { key: 'community' };
		}
		const settings = {
			communityReporterEnabled: !!doc.communityReporterEnabled,
			reporterPortalEnabled: !!doc.reporterPortalEnabled,
			allowNewSubmissions: !!doc.allowNewSubmissions,
			allowMyStoriesPortal: !!doc.allowMyStoriesPortal,
			allowJournalistApplications: !!doc.allowJournalistApplications,
			safeModeManualReviewOnly: !!doc.safeModeManualReviewOnly,
		};
		return res.json({ ok: true, settings });
	} catch (err) {
		console.error('getPublicCommunitySettings error', err);
		return res.status(200).json({
			ok: true,
			settings: {
				communityReporterEnabled: true,
				reporterPortalEnabled: true,
				allowNewSubmissions: true,
				allowMyStoriesPortal: true,
				allowJournalistApplications: true,
				safeModeManualReviewOnly: false,
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