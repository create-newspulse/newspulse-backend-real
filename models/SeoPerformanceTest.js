const mongoose = require('mongoose');

const SeoPerformanceTestSchema = new mongoose.Schema(
  {
    siteUrl: { type: String, required: true, index: true },
    status: { type: String, enum: ['completed', 'failed'], required: true, index: true },
    desktopScore: { type: Number, min: 0, max: 100, default: null },
    mobileScore: { type: Number, min: 0, max: 100, default: null },
    source: { type: String, default: null },
    checkedAt: { type: Date, default: null, index: true },
    unavailableReason: { type: String, default: null },
    message: { type: String, default: null },
    durationMs: { type: Number, min: 0, default: null },
    createdBy: { type: String, default: null, index: true },
  },
  { timestamps: true, collection: 'seo_performance_tests' },
);

SeoPerformanceTestSchema.index({ checkedAt: -1 });

module.exports = mongoose.models.SeoPerformanceTest || mongoose.model('SeoPerformanceTest', SeoPerformanceTestSchema);