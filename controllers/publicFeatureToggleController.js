const SystemSettings = require('../models/SystemSettings');

async function getOrCreateSystemSettings() {
  return SystemSettings.getSingleton();
}

async function getPublicFeatureToggles(req, res, next) {
  try {
    const doc = await getOrCreateSystemSettings();
    res.json({
      communityReporterEnabled: !!doc.communityReporterEnabled,
      reporterPortalEnabled: !!doc.reporterPortalEnabled,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPublicFeatureToggles };
