const mongoose = require('mongoose');

const NewsPulseAlert = require('../models/NewsPulseAlert');
const NewsPulseIncident = require('../models/NewsPulseIncident');
const User = require('../models/User');
const {
  classifyAndWrapMailerError,
  DEFAULT_MAIL_SCOPE,
  getMailerStatus,
  sendMail,
} = require('../lib/mailer');

const ALERT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SYSTEM_ALERT_TYPES = new Set(['critical', 'recovery']);

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function safeText(value, maxLength = 500) {
  const text = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength - 1).trim() : text;
}

function getId(doc) {
  return doc && (doc._id || doc.id);
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function isDuplicateKeyError(error) {
  return !!(error && (error.code === 11000 || String(error.code) === '11000' || /E11000|duplicate key/i.test(String(error.message || ''))));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}

function buildAlertPayload(type, incident, now) {
  const area = safeText(incident && incident.area, 160) || safeText(incident && incident.checkId, 160) || 'Unknown';
  const startedAt = incident && incident.startedAt ? new Date(incident.startedAt) : now;
  const resolvedAt = incident && incident.resolvedAt ? new Date(incident.resolvedAt) : null;
  const durationMs = typeof incident?.durationMs === 'number'
    ? incident.durationMs
    : (resolvedAt ? Math.max(0, resolvedAt.getTime() - startedAt.getTime()) : null);

  if (type === 'recovery') {
    return {
      title: 'News Pulse Recovered',
      area,
      message: `${area} has recovered.`,
      incidentMessage: safeText(incident && incident.message),
      recommendation: safeText(incident && incident.recommendation),
      startedAt,
      resolvedAt: resolvedAt || now,
      durationMs,
    };
  }

  return {
    title: 'News Pulse Critical Alert',
    area,
    message: `${area} has entered a critical state.`,
    incidentMessage: safeText(incident && incident.message),
    recommendation: safeText(incident && incident.recommendation),
    startedAt,
    resolvedAt: null,
    durationMs: null,
  };
}

function buildEmailText(alert) {
  const lines = [
    alert.title,
    '',
    `Area: ${alert.area}`,
    `Message: ${alert.message}`,
    `Started at: ${new Date(alert.startedAt).toISOString()}`,
  ];
  if (alert.resolvedAt) lines.push(`Resolved at: ${new Date(alert.resolvedAt).toISOString()}`);
  if (typeof alert.durationMs === 'number') lines.push(`Duration: ${formatDuration(alert.durationMs)}`);
  if (alert.incidentMessage) lines.push(`Incident detail: ${alert.incidentMessage}`);
  if (alert.recommendation) lines.push(`Recommendation: ${alert.recommendation}`);
  return lines.join('\n');
}

function alertClaimFields(type) {
  if (type === 'recovery') {
    return { claimedAt: 'recoveryAlertClaimedAt', sentAt: 'recoveryAlertSentAt' };
  }
  return { claimedAt: 'criticalAlertClaimedAt', sentAt: 'criticalAlertSentAt' };
}

async function claimIncidentAlert(type, incident, now) {
  const incidentId = getId(incident);
  if (!incidentId) return null;
  const fields = alertClaimFields(type);
  const filter = { _id: incidentId, [fields.claimedAt]: null };
  if (type === 'critical') filter.status = 'critical';
  if (type === 'recovery') filter.state = 'resolved';
  return NewsPulseIncident.findOneAndUpdate(filter, {
    $set: { [fields.claimedAt]: now },
  }, { new: true });
}

async function markIncidentAlertSent(type, incident, now) {
  const incidentId = getId(incident);
  if (!incidentId) return null;
  const fields = alertClaimFields(type);
  return NewsPulseIncident.findByIdAndUpdate(incidentId, {
    $set: { [fields.sentAt]: now },
  }, { new: true });
}

async function resolveFounderAlertRecipient(options = {}) {
  if (typeof options.resolveFounderRecipient === 'function') {
    return options.resolveFounderRecipient();
  }

  if (isDbReady()) {
    const founder = await User.findOne({
      email: { $exists: true, $ne: '' },
      $or: [{ isFounder: true }, { role: /^founder$/i }],
      isDeleted: { $ne: true },
      accountStatus: { $ne: 'deleted' },
      status: { $nin: ['deleted', 'deleted_test', 'archived'] },
    }).sort({ isFounder: -1, createdAt: 1 }).lean();
    if (founder && founder.email) return { email: String(founder.email).trim().toLowerCase(), source: 'founder_user' };
  }

  const configuredEmail = String(process.env.FOUNDER_ALERT_EMAIL || process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (configuredEmail) return { email: configuredEmail, source: 'founder_config' };
  return null;
}

async function markAlertDelivery(alert, update) {
  const id = getId(alert);
  if (!id) return null;
  return NewsPulseAlert.findByIdAndUpdate(id, { $set: update }, { new: true });
}

async function deliverAlert(alert, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const status = getMailerStatus({ scope: DEFAULT_MAIL_SCOPE });

  if (typeof options.deliverFounderAlert === 'function') {
    const result = await options.deliverFounderAlert(alert);
    return markAlertDelivery(alert, {
      deliveryStatus: 'sent',
      deliveryProvider: safeText(result && result.provider, 80) || 'test',
      deliveryAttemptedAt: now,
      sentAt: now,
      deliveryErrorCode: null,
    });
  }

  if (!status.configured) {
    return markAlertDelivery(alert, {
      deliveryStatus: 'recorded',
      deliveryProvider: status.provider || null,
      deliveryAttemptedAt: now,
      sentAt: null,
      deliveryErrorCode: 'MAILER_NOT_CONFIGURED',
    });
  }

  const recipient = await resolveFounderAlertRecipient(options);
  if (!recipient || !recipient.email) {
    return markAlertDelivery(alert, {
      deliveryStatus: 'recorded',
      deliveryProvider: status.provider || null,
      deliveryAttemptedAt: now,
      sentAt: null,
      deliveryErrorCode: 'FOUNDER_RECIPIENT_UNAVAILABLE',
    });
  }

  const subjectPrefix = alert.type === 'recovery' ? 'Recovered' : 'Critical';
  await sendMail({
    to: recipient.email,
    subject: `[News Pulse] ${subjectPrefix}: ${alert.area}`,
    text: buildEmailText(alert),
  }, { scope: DEFAULT_MAIL_SCOPE });

  return markAlertDelivery(alert, {
    deliveryStatus: 'sent',
    deliveryProvider: status.provider || null,
    deliveryAttemptedAt: now,
    sentAt: now,
    deliveryErrorCode: null,
  });
}

async function hasCriticalAlert(incidentId) {
  const existing = await NewsPulseAlert.findOne({ incidentId: String(incidentId), type: 'critical' }).lean();
  return !!existing;
}

async function createFounderIncidentAlert(type, incident, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!SYSTEM_ALERT_TYPES.has(type)) return { action: 'skipped', reason: 'unsupported_alert_type' };
  const incidentId = getId(incident);
  if (!incidentId) return { action: 'skipped', reason: 'missing_incident_id' };
  if (type === 'recovery' && !(await hasCriticalAlert(incidentId))) {
    return { action: 'skipped', reason: 'no_prior_critical_alert' };
  }
  const claimedIncident = await claimIncidentAlert(type, incident, now);
  if (!claimedIncident) return { action: 'duplicate', type, incidentId: String(incidentId) };

  const payload = buildAlertPayload(type, claimedIncident || incident, now);
  let alert = null;
  try {
    alert = await NewsPulseAlert.create({
      incidentId: String(incidentId),
      checkId: safeText(incident.checkId, 160) || 'unknown',
      type,
      ...payload,
      deliveryStatus: 'pending',
      claimedAt: now,
      expiresAt: addMs(now, ALERT_RETENTION_MS),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return { action: 'duplicate', type, incidentId: String(incidentId) };
    throw error;
  }

  try {
    await deliverAlert(alert, { ...options, now });
    await markIncidentAlertSent(type, claimedIncident || incident, now);
    return { action: 'created', type, incidentId: String(incidentId) };
  } catch (error) {
    const classified = classifyAndWrapMailerError(error, { scope: DEFAULT_MAIL_SCOPE });
    await markAlertDelivery(alert, {
      deliveryStatus: 'failed',
      deliveryProvider: classified.provider || null,
      deliveryAttemptedAt: now,
      sentAt: null,
      deliveryErrorCode: classified.backendCode || 'PROVIDER_UNAVAILABLE',
    });
    return { action: 'created', type, incidentId: String(incidentId), deliveryStatus: 'failed' };
  }
}

async function safelyCreateFounderIncidentAlert(type, incident, options = {}) {
  try {
    return await createFounderIncidentAlert(type, incident, options);
  } catch (error) {
    try { options.logger?.warn?.('[NEWS_PULSE_ENGINE][alerts] failed', { type, message: error?.message || String(error) }); } catch (_) {}
    return { action: 'error', type, message: error?.message || String(error) };
  }
}

function normalizeAlert(doc) {
  if (!doc) return null;
  const id = getId(doc);
  return {
    id: id ? String(id) : null,
    incidentId: doc.incidentId ? String(doc.incidentId) : null,
    checkId: doc.checkId || null,
    type: doc.type || null,
    title: doc.title || null,
    area: doc.area || null,
    message: doc.message || '',
    incidentMessage: doc.incidentMessage || '',
    recommendation: doc.recommendation || '',
    startedAt: doc.startedAt ? new Date(doc.startedAt).toISOString() : null,
    resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt).toISOString() : null,
    durationMs: typeof doc.durationMs === 'number' ? doc.durationMs : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    deliveryStatus: doc.deliveryStatus || 'recorded',
    deliveryProvider: doc.deliveryProvider || null,
    sentAt: doc.sentAt ? new Date(doc.sentAt).toISOString() : null,
    deliveryErrorCode: doc.deliveryErrorCode || null,
  };
}

async function listAlerts({ limit = 50, type } = {}) {
  if (!isDbReady()) return { ok: false, status: 503, message: 'Database unavailable', alerts: [] };
  const filter = {};
  const typeNorm = String(type || '').trim().toLowerCase();
  if (SYSTEM_ALERT_TYPES.has(typeNorm)) filter.type = typeNorm;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const docs = await NewsPulseAlert.find(filter).sort({ createdAt: -1 }).limit(safeLimit).lean();
  return { ok: true, status: 200, alerts: (docs || []).map(normalizeAlert) };
}

module.exports = {
  ALERT_RETENTION_MS,
  buildAlertPayload,
  buildEmailText,
  claimIncidentAlert,
  createFounderIncidentAlert,
  formatDuration,
  isDuplicateKeyError,
  listAlerts,
  markIncidentAlertSent,
  normalizeAlert,
  resolveFounderAlertRecipient,
  safelyCreateFounderIncidentAlert,
};