// models/CommunityReporterSettings.js
const mongoose = require('mongoose');

const CommunityReporterSettingsSchema = new mongoose.Schema(
  {
    // single global flag for the whole site
    myCommunityStoriesEnabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    collection: 'community_reporter_settings',
    timestamps: true,
  }
);

module.exports = mongoose.model(
  'CommunityReporterSettings',
  CommunityReporterSettingsSchema
);
