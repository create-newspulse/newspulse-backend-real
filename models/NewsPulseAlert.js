const mongoose = require('mongoose');

const ALERT_TYPES = ['critical', 'recovery'];
const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'recorded'];
const DEFAULT_RETENTION_DAYS = 30;

const NewsPulseAlertSchema = new mongoose.Schema(
  {
    incidentId: { type: String, required: true, trim: true, index: true },
    checkId: { type: String, required: true, trim: true, index: true },
    type: { type: String, required: true, enum: ALERT_TYPES, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    area: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    incidentMessage: { type: String, default: '', trim: true, maxlength: 500 },
    recommendation: { type: String, default: '', trim: true, maxlength: 500 },
    startedAt: { type: Date, required: true, index: true },
    resolvedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, default: null, min: 0 },
    deliveryStatus: { type: String, enum: DELIVERY_STATUSES, default: 'pending', index: true },
    deliveryProvider: { type: String, default: null, trim: true, maxlength: 80 },
    deliveryAttemptedAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null, index: true },
    deliveryErrorCode: { type: String, default: null, trim: true, maxlength: 120 },
    claimedAt: { type: Date, required: true, default: Date.now, index: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, collection: 'news_pulse_alerts' },
);

NewsPulseAlertSchema.index(
  { incidentId: 1, type: 1 },
  { unique: true, name: 'uniq_news_pulse_alert_per_incident_type' },
);
NewsPulseAlertSchema.index({ createdAt: -1 });
NewsPulseAlertSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'news_pulse_alert_retention_ttl' });

module.exports = mongoose.models.NewsPulseAlert || mongoose.model('NewsPulseAlert', NewsPulseAlertSchema);
module.exports.ALERT_TYPES = ALERT_TYPES;
module.exports.DELIVERY_STATUSES = DELIVERY_STATUSES;
module.exports.DEFAULT_RETENTION_DAYS = DEFAULT_RETENTION_DAYS;