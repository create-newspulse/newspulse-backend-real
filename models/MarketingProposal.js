const mongoose = require('mongoose');

const MarketingProposalSchema = new mongoose.Schema(
  {
    proposalId: { type: String, required: true, unique: true, index: true, trim: true },
    advertiserId: { type: String, required: true, index: true, trim: true },
    primaryContactId: { type: String, default: null, trim: true },
    ownerId: { type: String, default: null, index: true, trim: true },
    renewalId: { type: String, default: null, index: true, trim: true },
    status: { type: String, enum: ['draft', 'sent', 'negotiation', 'won', 'lost', 'archived'], default: 'draft', index: true },
    productIds: { type: [String], default: [] },
    placementIds: { type: [String], default: [] },
    scope: { type: mongoose.Schema.Types.Mixed, default: null },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

MarketingProposalSchema.index({ advertiserId: 1, status: 1 });
MarketingProposalSchema.index({ renewalId: 1, status: 1 });

module.exports = mongoose.models.MarketingProposal || mongoose.model('MarketingProposal', MarketingProposalSchema);