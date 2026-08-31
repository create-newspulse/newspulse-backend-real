const mongoose = require('mongoose');

const INCIDENT_STATES = ['open', 'resolved'];
const INCIDENT_STATUSES = ['attention', 'critical'];

const NewsPulseIncidentSchema = new mongoose.Schema(
  {
    checkId: { type: String, required: true, trim: true, index: true },
    area: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: INCIDENT_STATUSES, index: true },
    message: { type: String, default: '', trim: true },
    recommendation: { type: String, default: '', trim: true },
    startedAt: { type: Date, required: true, default: Date.now, index: true },
    lastSeenAt: { type: Date, required: true, default: Date.now, index: true },
    resolvedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, default: null, min: 0 },
    state: { type: String, required: true, enum: INCIDENT_STATES, default: 'open', index: true },
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: 'news_pulse_incidents' },
);

NewsPulseIncidentSchema.index({ checkId: 1, state: 1, startedAt: -1 });
NewsPulseIncidentSchema.index(
  { checkId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: 'open' },
    name: 'uniq_open_news_pulse_incident_per_check',
  },
);
NewsPulseIncidentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.NewsPulseIncident || mongoose.model('NewsPulseIncident', NewsPulseIncidentSchema);
module.exports.INCIDENT_STATES = INCIDENT_STATES;
module.exports.INCIDENT_STATUSES = INCIDENT_STATUSES;