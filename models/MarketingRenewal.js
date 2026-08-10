const mongoose = require('mongoose');

const statusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    changedBy: { type: String, default: null, trim: true },
    changedAt: { type: Date, default: Date.now },
    note: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const MarketingRenewalSchema = new mongoose.Schema(
  {
    renewalId: { type: String, required: true, unique: true, index: true, trim: true },
    advertiserId: { type: String, required: true, index: true, trim: true },
    previousDealId: { type: String, default: null, index: true, trim: true },
    previousCampaignId: { type: String, default: null, index: true, trim: true },
    previousProposalId: { type: String, default: null, index: true, trim: true },
    previousCampaignValue: { type: Number, default: null },
    campaignEndDate: { type: Date, default: null, index: true },
    followUpDate: { type: Date, required: true, index: true },
    ownerId: { type: String, required: true, index: true, trim: true },
    status: {
      type: String,
      enum: ['upcoming', 'contact_due', 'contacted', 'interested', 'proposal', 'negotiation', 'renewed', 'not_renewing', 'paused'],
      default: 'upcoming',
      index: true,
    },
    notes: { type: String, default: '', trim: true },
    newProposalId: { type: String, default: null, index: true, trim: true },
    renewedDealId: { type: String, default: null, index: true, trim: true },
    sourceType: { type: String, enum: ['completed_advertiser_campaign', 'won_deal', 'completed_partnership', 'manual'], default: 'manual' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: String, default: null, trim: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

MarketingRenewalSchema.index({ advertiserId: 1, ownerId: 1, status: 1 });
MarketingRenewalSchema.index({ advertiserId: 1, previousDealId: 1, previousCampaignId: 1, status: 1 });
MarketingRenewalSchema.index({ followUpDate: 1, status: 1 });

module.exports = mongoose.models.MarketingRenewal || mongoose.model('MarketingRenewal', MarketingRenewalSchema);