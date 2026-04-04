const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');

async function getPublicFeatureToggles(req, res, next) {
  try {
    const state = await getEffectiveCommunityAccessState();
    res.json({
      communityReporterEnabled: state.communityReporterEnabled,
      reporterPortalEnabled: state.reporterPortalEnabled,
      communityReporterClosed: state.communityReporterClosed,
      reporterPortalClosed: state.reporterPortalClosed,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPublicFeatureToggles };
