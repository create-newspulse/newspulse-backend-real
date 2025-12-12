const mongoose = require("mongoose");

const FounderFeatureTogglesSchema = new mongoose.Schema(
  {
    // We use a fixed key string instead of many docs
    key: { type: String, required: true, unique: true, index: true },

    // ON = closed / hidden, OFF = open / visible
    communityReporterClosed: { type: Boolean, default: false },
    reporterPortalClosed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.FounderFeatureToggles ||
  mongoose.model("FounderFeatureToggles", FounderFeatureTogglesSchema);
