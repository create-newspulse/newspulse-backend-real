const mongoose = require('mongoose');

const FeatureTogglesSchema = new mongoose.Schema(
  {
    communityReporterClosed: { type: Boolean, default: false },
    reporterPortalClosed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Single document collection (use key if needed later)
module.exports = mongoose.model('FeatureToggles', FeatureTogglesSchema);
