const mongoose = require('mongoose');

const SystemSettingsSchema = new mongoose.Schema({
  communityMyStoriesEnabled: { type: Boolean, default: true },
  // Feature flags
  communityReporterEnabled: { type: Boolean, default: true },
  reporterPortalEnabled: { type: Boolean, default: true },
  // Founder Feature Toggles for Community Reporter
  allowNewSubmissions: { type: Boolean, default: true },
  allowJournalistApplications: { type: Boolean, default: true },
  safeModeManualReviewOnly: { type: Boolean, default: false },
}, { timestamps: true });

SystemSettingsSchema.statics.getSingleton = async function() {
  const Model = this;
  let doc = await Model.findOne({});
  if (!doc) {
    doc = await Model.create({});
  }
  return doc;
};

module.exports = mongoose.models.SystemSettings || mongoose.model('SystemSettings', SystemSettingsSchema);
