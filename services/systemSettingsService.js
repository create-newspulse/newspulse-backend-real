const SystemSettings = require('../models/SystemSettings');

async function getSystemSettings() {
  return SystemSettings.getSingleton();
}

async function updateCommunityConfig(partial) {
  const doc = await SystemSettings.getSingleton();
  if (typeof partial.communityMyStoriesEnabled !== 'undefined') {
    doc.communityMyStoriesEnabled = Boolean(partial.communityMyStoriesEnabled);
  }
  await doc.save();
  return doc;
}

module.exports = { getSystemSettings, updateCommunityConfig };
