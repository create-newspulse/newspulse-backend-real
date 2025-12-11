const mongoose = require('mongoose');

const CommunityFeatureSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },

  // Two main toggles
  communityReporterEnabled: { type: Boolean, default: true },
  reporterPortalEnabled: { type: Boolean, default: true },

  // Extra switches (you can use later)
  allowNewSubmissions: { type: Boolean, default: true },
  allowMyStoriesPortal: { type: Boolean, default: true },
  allowJournalistApplications: { type: Boolean, default: true },
  safeModeManualReviewOnly: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.models.CommunityFeatureSettings || mongoose.model('CommunityFeatureSettings', CommunityFeatureSettingsSchema);
