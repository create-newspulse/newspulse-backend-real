const { Schema, model } = require('mongoose');

const CommunitySettingsSchema = new Schema(
  {
    communityReporterEnabled: { type: Boolean, default: true },
    allowNewSubmissions: { type: Boolean, default: true },
    allowMyStoriesPortal: { type: Boolean, default: true },
    allowJournalistApplications: { type: Boolean, default: true },
    safeModeManualReviewOnly: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = model('CommunitySettings', CommunitySettingsSchema);
