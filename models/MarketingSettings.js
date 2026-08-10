const mongoose = require('mongoose');

const MarketingSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    requireCampaignReportApproval: { type: Boolean, default: false, index: true },
    updatedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

module.exports = mongoose.models.MarketingSettings || mongoose.model('MarketingSettings', MarketingSettingsSchema);