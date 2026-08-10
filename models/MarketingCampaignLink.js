const mongoose = require('mongoose');

const MarketingCampaignLinkSchema = new mongoose.Schema(
  {
    campaignLinkId: { type: String, required: true, unique: true, index: true, trim: true },
    advertiserId: { type: String, required: true, index: true, trim: true },
    advertiserName: { type: String, default: null, trim: true },
    dealId: { type: String, default: null, index: true, trim: true },
    proposalId: { type: String, default: null, index: true, trim: true },
    adsManagerCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', default: null, index: true },
    campaignName: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled', 'archived'],
      default: 'draft',
      index: true,
    },
    startDate: { type: Date, default: null, index: true },
    endDate: { type: Date, default: null, index: true },
    placements: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    targetRegion: { type: String, default: null, trim: true },
    ownerId: { type: String, default: null, index: true, trim: true },
    campaignCommercialValue: { type: Number, default: null },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

MarketingCampaignLinkSchema.index({ advertiserId: 1, status: 1 });
MarketingCampaignLinkSchema.index({ ownerId: 1, status: 1 });
MarketingCampaignLinkSchema.index({ dealId: 1, adsManagerCampaignId: 1 });

module.exports = mongoose.models.MarketingCampaignLink || mongoose.model('MarketingCampaignLink', MarketingCampaignLinkSchema);