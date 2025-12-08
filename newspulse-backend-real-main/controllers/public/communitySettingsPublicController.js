const { getCommunitySettings } = require('../../../services/communitySettingsService');

async function getPublicCommunitySettings(req, res) {
  try {
    const settings = await getCommunitySettings();
    return res.json({
      ok: true,
      settings: {
        communityReporterEnabled: settings.communityReporterEnabled,
        allowNewSubmissions: settings.allowNewSubmissions,
        allowMyStoriesPortal: settings.allowMyStoriesPortal,
        allowJournalistApplications: settings.allowJournalistApplications,
      },
    });
  } catch (err) {
    console.error('getPublicCommunitySettings error', err);
    return res.status(500).json({ ok: false, message: 'Failed to load settings' });
  }
}

module.exports = { getPublicCommunitySettings };
