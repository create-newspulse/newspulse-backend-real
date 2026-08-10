const mongoose = require('mongoose');

const performanceSnapshotSchema = new mongoose.Schema(
  {
    impressions: { type: Number, default: null },
    clicks: { type: Number, default: null },
    ctr: { type: Number, default: null },
    otherSupportedMetrics: { type: mongoose.Schema.Types.Mixed, default: undefined },
    status: { type: String, enum: ['connected', 'not_connected', 'partial', 'error'], default: 'not_connected' },
    trackingStatus: { type: String, enum: ['connected', 'not_connected', 'partial', 'error'], default: 'not_connected' },
    source: { type: String, enum: ['ads_manager', 'analytics', 'combined', 'none'], default: 'none' },
    lastUpdatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const MarketingCampaignReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true, trim: true },
    advertiserId: { type: String, required: true, index: true, trim: true },
    dealId: { type: String, default: null, index: true, trim: true },
    proposalId: { type: String, default: null, index: true, trim: true },
    marketingCampaignLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingCampaignLink', default: null, index: true },
    adsManagerCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', default: null, index: true },
    title: { type: String, required: true, trim: true },
    campaignStartDate: { type: Date, default: null },
    campaignEndDate: { type: Date, default: null },
    performanceSnapshot: { type: performanceSnapshotSchema, default: () => ({}) },
    performanceSource: { type: String, enum: ['ads_manager', 'analytics', 'combined', 'none'], default: 'none' },
    performanceCapturedAt: { type: Date, default: null, index: true },
    summary: { type: String, default: '', trim: true },
    campaignNotes: { type: String, default: '', trim: true },
    recommendations: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['draft', 'ready', 'pending_approval', 'approved', 'shared', 'archived'],
      default: 'draft',
      index: true,
    },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    preparedBy: { type: String, default: null, trim: true },
    preparedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null, trim: true },
    approvedAt: { type: Date, default: null },
    approvalNote: { type: String, default: '', trim: true },
    sharedBy: { type: String, default: null, trim: true },
    sharedAt: { type: Date, default: null },
    sharedVia: { type: String, enum: ['email', 'whatsapp', 'in_person', 'other', null], default: null },
    archivedBy: { type: String, default: null, trim: true },
    archivedAt: { type: Date, default: null, index: true },
    deletedBy: { type: String, default: null, trim: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

MarketingCampaignReportSchema.index({ advertiserId: 1, createdAt: -1 });
MarketingCampaignReportSchema.index({ adsManagerCampaignId: 1, createdAt: -1 });
MarketingCampaignReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.MarketingCampaignReport || mongoose.model('MarketingCampaignReport', MarketingCampaignReportSchema);