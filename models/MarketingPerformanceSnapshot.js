const mongoose = require('mongoose');

const MarketingPerformanceSnapshotSchema = new mongoose.Schema(
  {
    entityType: { type: String, required: true, index: true, trim: true },
    entityId: { type: String, required: true, index: true, trim: true },
    metric: { type: String, required: true, index: true, trim: true },
    value: { type: Number, default: null },
    source: { type: String, enum: ['ads_manager', 'analytics', 'combined', 'manual_verified'], required: true, index: true },
    capturedAt: { type: Date, default: Date.now, index: true },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

MarketingPerformanceSnapshotSchema.index({ entityType: 1, entityId: 1, capturedAt: -1 });

module.exports = mongoose.models.MarketingPerformanceSnapshot || mongoose.model('MarketingPerformanceSnapshot', MarketingPerformanceSnapshotSchema);