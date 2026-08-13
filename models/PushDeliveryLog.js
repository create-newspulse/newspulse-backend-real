const mongoose = require('mongoose');

const DEFAULT_RETENTION_DAYS = 30;

function getPushHistoryRetentionDays() {
  const raw = Number.parseInt(process.env.PUSH_HISTORY_RETENTION_DAYS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_DAYS;
  return raw;
}

const pushDeliveryLogSchema = new mongoose.Schema({
  type: { type: String, enum: ['breaking', 'article'], required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  body: { type: String, required: true, trim: true, maxlength: 500 },
  url: { type: String, required: true, trim: true, maxlength: 1000 },
  articleId: { type: String, default: null, trim: true, maxlength: 200, index: true },
  articleSlug: { type: String, default: null, trim: true, maxlength: 240, index: true },
  category: { type: String, default: null, trim: true, maxlength: 80, index: true },
  language: { type: String, default: null, trim: true, maxlength: 12, index: true },
  targetedCount: { type: Number, default: 0, min: 0 },
  successCount: { type: Number, default: 0, min: 0 },
  failureCount: { type: Number, default: 0, min: 0 },
  browserReceivedCount: { type: Number, default: 0, min: 0 },
  clickedCount: { type: Number, default: 0, min: 0 },
  firstReceivedAt: { type: Date, default: null, index: true },
  lastReceivedAt: { type: Date, default: null, index: true },
  firstClickedAt: { type: Date, default: null, index: true },
  lastClickedAt: { type: Date, default: null, index: true },
  sentAt: { type: Date, default: Date.now, index: true },
  completedAt: { type: Date, default: null, index: true },
  sentBy: {
    id: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
    role: { type: String, default: null, trim: true },
  },
  metadata: {
    targeting: {
      enabledDevices: { type: Number, default: 0, min: 0 },
      newArticleAlertEligibleDevices: { type: Number, default: 0, min: 0 },
      excludedDisabledCount: { type: Number, default: 0, min: 0 },
      excludedPreferenceOffCount: { type: Number, default: 0, min: 0 },
      targetedCount: { type: Number, default: 0, min: 0 },
    },
    firebaseFailures: [{
      code: { type: String, default: null, trim: true, maxlength: 120 },
      message: { type: String, default: null, trim: true, maxlength: 240 },
      count: { type: Number, default: 0, min: 0 },
    }],
  },
  lastFailureCode: { type: String, default: null, trim: true, maxlength: 120 },
  lastFailureMessage: { type: String, default: null, trim: true, maxlength: 240 },
}, { timestamps: true });

pushDeliveryLogSchema.index({ type: 1, sentAt: -1 });
pushDeliveryLogSchema.index({ sentAt: -1 });
pushDeliveryLogSchema.index(
  { sentAt: 1 },
  { expireAfterSeconds: getPushHistoryRetentionDays() * 24 * 60 * 60, name: 'push_delivery_log_retention_ttl' },
);

pushDeliveryLogSchema.statics.getHistoryRetentionDays = getPushHistoryRetentionDays;

module.exports = mongoose.models.PushDeliveryLog || mongoose.model('PushDeliveryLog', pushDeliveryLogSchema);
