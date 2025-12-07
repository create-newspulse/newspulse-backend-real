const SystemSettings = require('../models/SystemSettings');

async function getCommunityReporterSettings(req, res, _next) {
  try {
    const settings = await SystemSettings.getSingleton();
    const flag = typeof settings.communityMyStoriesEnabled === 'boolean'
      ? settings.communityMyStoriesEnabled
      : false;
    return res.json({
      success: true,
      settings: { myCommunityStoriesEnabled: !!flag },
    });
  } catch (err) {
    console.error('[community-reporter][GET]', err?.message || err);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Failed to load setting',
    });
  }
}

async function updateCommunityReporterSettings(req, res, _next) {
  try {
    const raw = req.body && req.body.myCommunityStoriesEnabled;
    const val = !!raw;
    const settings = await SystemSettings.getSingleton();
    settings.communityMyStoriesEnabled = val;
    await settings.save();
    return res.json({
      success: true,
      settings: { myCommunityStoriesEnabled: !!settings.communityMyStoriesEnabled },
    });
  } catch (err) {
    console.error('[community-reporter][POST]', err?.message || err);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Failed to save setting',
    });
  }
}

module.exports = {
  getCommunityReporterSettings,
  updateCommunityReporterSettings,
};
