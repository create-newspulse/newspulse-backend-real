const CommunitySettings = require('../models/CommunitySettings');
const { getEffectiveCommunityAccessState } = require('./communityAccessToggleService');

async function getCommunitySettings() {
  const existing = await CommunitySettings.findOne().lean();
  const base = existing || (await CommunitySettings.create({})).toObject();
  const effective = await getEffectiveCommunityAccessState();

  return {
    ...base,
    communityReporterEnabled: effective.communityReporterEnabled,
    reporterPortalEnabled: effective.reporterPortalEnabled,
    allowNewSubmissions: effective.allowNewSubmissions,
    allowMyStoriesPortal: effective.allowMyStoriesPortal,
    allowJournalistApplications: effective.allowJournalistApplications,
    safeModeManualReviewOnly: effective.safeModeManualReviewOnly,
    communityReporterClosed: effective.communityReporterClosed,
    reporterPortalClosed: effective.reporterPortalClosed,
    communityMyStoriesEnabled: effective.communityMyStoriesEnabled,
  };
}

async function updateCommunitySettings(patch = {}) {
  const current = await CommunitySettings.findOne();
  if (!current) {
    const created = await CommunitySettings.create(patch || {});
    return created;
  }
  Object.assign(current, patch || {});
  await current.save();
  return current;
}

module.exports = { getCommunitySettings, updateCommunitySettings };
