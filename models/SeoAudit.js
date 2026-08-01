const mongoose = require('mongoose');

const UrlCheckSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    status: { type: Number, default: null },
    ok: { type: Boolean, default: false },
    contentType: { type: String, default: null },
    checks: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: null },
  },
  { _id: false },
);

const ResultSchema = new mongoose.Schema(
  {
    checkCode: { type: String, required: true },
    category: { type: String, required: true },
    severity: { type: String, enum: ['critical', 'warning', 'passed'], required: true },
    pageUrl: { type: String, default: null },
    title: { type: String, default: null },
    description: { type: String, default: null },
    currentValue: { type: mongoose.Schema.Types.Mixed, default: null },
    recommendedAction: { type: String, default: null },
  },
  { _id: false },
);

const SeoAuditSchema = new mongoose.Schema(
  {
    siteUrl: { type: String, required: true, index: true },
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued', index: true },
    mode: { type: String, enum: ['quick', 'full'], default: 'quick', index: true },
    includePerformance: { type: Boolean, default: false },
    totalPages: { type: Number, default: 0 },
    progressPercent: { type: Number, min: 0, max: 100, default: 0 },
    currentStage: { type: String, default: null },
    currentUrl: { type: String, default: null },
    lastProgressAt: { type: Date, default: null },
    score: { type: Number, min: 0, max: 100, default: null },
    pagesChecked: { type: Number, default: 0 },
    passedCount: { type: Number, default: 0 },
    warningCount: { type: Number, default: 0 },
    criticalCount: { type: Number, default: 0 },
    scoreBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
    scoreExplanation: { type: String, default: null },
    scoreUnavailableReason: { type: String, default: null },
    startedAt: { type: Date, required: true, index: true },
    completedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, min: 0, default: null },
    urlsChecked: { type: [UrlCheckSchema], default: [] },
    results: { type: [ResultSchema], default: [] },
    passedChecks: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    criticalIssues: { type: [String], default: [] },
    performance: {
      desktopScore: { type: Number, min: 0, max: 100, default: null },
      mobileScore: { type: Number, min: 0, max: 100, default: null },
      source: { type: String, default: null },
      checkedAt: { type: Date, default: null },
      unavailableReason: { type: String, default: null },
    },
    timings: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestMetrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    errorMessage: { type: String, default: null },
    requestedBy: {
      id: { type: String, default: null },
      email: { type: String, default: null },
      name: { type: String, default: null },
      role: { type: String, default: null },
      staffId: { type: String, default: null },
    },
    createdBy: { type: String, default: null, index: true },
  },
  { timestamps: true, collection: 'seo_audits' },
);

SeoAuditSchema.index({ status: 1, startedAt: -1 });
SeoAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.models.SeoAudit || mongoose.model('SeoAudit', SeoAuditSchema);