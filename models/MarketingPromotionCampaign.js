const mongoose = require('mongoose');

const MarketingPromotionCampaignSchema = new mongoose.Schema(
  {
    promotionId: { type: String, required: true, unique: true, index: true, trim: true },
    title: { type: String, required: true, trim: true },
    utmCampaign: { type: String, default: null, index: true, trim: true },
    language: { type: String, default: null, index: true, trim: true },
    channel: { type: String, default: null, index: true, trim: true },
    status: { type: String, enum: ['draft', 'scheduled', 'active', 'completed', 'paused', 'archived'], default: 'draft', index: true },
    startDate: { type: Date, default: null, index: true },
    endDate: { type: Date, default: null, index: true },
    ownerId: { type: String, default: null, index: true, trim: true },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

MarketingPromotionCampaignSchema.index({ status: 1, startDate: -1 });
MarketingPromotionCampaignSchema.index({ utmCampaign: 1, channel: 1 });

module.exports = mongoose.models.MarketingPromotionCampaign || mongoose.model('MarketingPromotionCampaign', MarketingPromotionCampaignSchema);