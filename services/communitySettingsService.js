const CommunitySettings = require('../models/CommunitySettings');

async function getCommunitySettings() {
  const existing = await CommunitySettings.findOne().lean();
  if (existing) return existing;
  const created = await CommunitySettings.create({});
  return created.toObject();
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
