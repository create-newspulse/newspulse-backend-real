const { getCommunitySettings } = require('../../../services/communitySettingsService');

async function getPublicCommunitySettings(req, res) {
  try {
    const settings = await getCommunitySettings();
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.json({
      ok: true,
      settings: {
        communityReporterEnabled: settings.communityReporterEnabled,
        reporterPortalEnabled: settings.reporterPortalEnabled,
        allowNewSubmissions: settings.allowNewSubmissions,
        allowMyStoriesPortal: settings.allowMyStoriesPortal,
        allowJournalistApplications: settings.allowJournalistApplications,
        communityReporterClosed: settings.communityReporterClosed,
        reporterPortalClosed: settings.reporterPortalClosed,
        communityMyStoriesEnabled: settings.communityMyStoriesEnabled,
      },
      featureToggles: {
        communityReporterClosed: settings.communityReporterClosed,
        reporterPortalClosed: settings.reporterPortalClosed,
      },
    });
  } catch (err) {
    console.error('getPublicCommunitySettings error', err);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.status(500).json({ ok: false, message: 'Failed to load settings' });
  }
}

module.exports = { getPublicCommunitySettings };
