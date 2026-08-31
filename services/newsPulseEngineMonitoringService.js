const mongoose = require('mongoose');

const NewsPulseIncident = require('../models/NewsPulseIncident');
const SystemSetting = require('../models/SystemSetting');
const { getNewsPulseEngineHealth } = require('./newsPulseEngineHealthService');
const { isProductionLike, isTestLike } = require('../lib/environmentSafety');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LATEST_STATE_KEY = 'news_pulse_engine.monitoring.latest_state';
const SYSTEM_ACTOR = { id: null, email: null, role: 'system' };

let monitoringTimer = null;
let monitoringInFlight = false;
let configuredIntervalMs = DEFAULT_INTERVAL_MS;
const runtimeStatus = {
  enabled: false,
  running: false,
  lastRunAt: null,
  lastRunStatus: 'never_run',
};

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function safeText(value, maxLength = 500) {
  const text = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength - 1).trim() : text;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function isKnownConfigurationOnlyCheck(check) {
  const id = String(check && check.id || '');
  const status = normalizeStatus(check && check.status);
  const message = String(check && check.message || '');

  if (id === 'analytics' && status === 'attention' && /not configured|could not be confirmed|disabled/i.test(message)) {
    return true;
  }

  if (id === 'admin-panel' && (status === 'unknown' || /not configured/i.test(message))) {
    return true;
  }

  return false;
}

function isIncidentEligible(check) {
  const status = normalizeStatus(check && check.status);
  if (status !== 'attention' && status !== 'critical') return false;
  if (isKnownConfigurationOnlyCheck(check)) return false;
  return true;
}

function shouldResolveOpenIncident(check) {
  const status = normalizeStatus(check && check.status);
  return status === 'healthy' || isKnownConfigurationOnlyCheck(check);
}

function incidentPatchFromCheck(check, now) {
  return {
    area: safeText(check.area || check.id || 'Unknown', 120),
    status: normalizeStatus(check.status),
    message: safeText(check.message),
    recommendation: safeText(check.recommendation),
    lastSeenAt: now,
  };
}

function getId(doc) {
  return doc && (doc._id || doc.id);
}

function isDuplicateKeyError(error) {
  return !!(error && (error.code === 11000 || String(error.code) === '11000' || /E11000|duplicate key/i.test(String(error.message || ''))));
}

async function findOpenIncident(checkId) {
  return NewsPulseIncident.findOne({ checkId, state: 'open' }).sort({ startedAt: -1 }).lean();
}

async function updateOpenIncident(checkId, patch) {
  const open = await findOpenIncident(checkId);
  if (!open) return null;
  await NewsPulseIncident.findByIdAndUpdate(getId(open), {
    $set: patch,
    $unset: { resolvedAt: 1, durationMs: 1, expiresAt: 1 },
  }, { new: true });
  return open;
}

async function updateLatestState(snapshot, now) {
  const checks = Array.isArray(snapshot && snapshot.checks) ? snapshot.checks : [];
  const value = {
    lastCheckedAt: now.toISOString(),
    overallStatus: safeText(snapshot && snapshot.overallStatus, 50),
    checks: checks.reduce((acc, check) => {
      if (!check || !check.id) return acc;
      acc[check.id] = {
        area: safeText(check.area || check.id, 120),
        status: normalizeStatus(check.status),
        message: safeText(check.message),
        checkedAt: check.checkedAt || now.toISOString(),
      };
      return acc;
    }, {}),
  };

  await SystemSetting.findOneAndUpdate(
    { key: LATEST_STATE_KEY },
    { $set: { key: LATEST_STATE_KEY, value, updatedBy: SYSTEM_ACTOR } },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  );

  return value;
}

async function processCheck(check, now) {
  if (!check || !check.id) return { action: 'skipped' };

  const open = await findOpenIncident(check.id);
  if (isIncidentEligible(check)) {
    const patch = incidentPatchFromCheck(check, now);
    if (open) {
      await NewsPulseIncident.findByIdAndUpdate(getId(open), {
        $set: patch,
        $unset: { resolvedAt: 1, durationMs: 1, expiresAt: 1 },
      }, { new: true });
      return { action: 'updated', checkId: check.id };
    }

    try {
      await NewsPulseIncident.create({
        checkId: check.id,
        ...patch,
        startedAt: now,
        state: 'open',
        resolvedAt: null,
        durationMs: null,
        expiresAt: null,
      });
      return { action: 'opened', checkId: check.id };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const updated = await updateOpenIncident(check.id, patch);
      if (!updated) throw error;
      return { action: 'updated', checkId: check.id, reason: 'duplicate_open_race' };
    }
  }

  if (open && shouldResolveOpenIncident(check)) {
    const startedAt = open.startedAt ? new Date(open.startedAt) : now;
    const durationMs = Math.max(0, now.getTime() - startedAt.getTime());
    await NewsPulseIncident.findByIdAndUpdate(getId(open), {
      $set: {
        state: 'resolved',
        lastSeenAt: now,
        resolvedAt: now,
        durationMs,
        expiresAt: addMs(now, RESOLVED_RETENTION_MS),
      },
    }, { new: true });
    return { action: 'resolved', checkId: check.id };
  }

  return { action: 'ignored', checkId: check.id };
}

async function recordHealthSnapshot(snapshot, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!isDbReady()) {
    return { ok: false, skipped: true, reason: 'db_not_ready', processed: [] };
  }

  const checks = Array.isArray(snapshot && snapshot.checks) ? snapshot.checks : [];
  const processed = [];
  for (const check of checks) {
    try {
      processed.push(await processCheck(check, now));
    } catch (error) {
      processed.push({ action: 'error', checkId: check && check.id, message: error?.message || String(error) });
    }
  }

  const latestState = await updateLatestState(snapshot, now);
  return { ok: true, processed, latestState };
}

async function runMonitoringOnce(options = {}) {
  if (monitoringInFlight) {
    return { ok: false, skipped: true, reason: 'already_running' };
  }

  monitoringInFlight = true;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const healthService = options.healthService || getNewsPulseEngineHealth;
  const logger = options.logger || console;

  try {
    const snapshot = await healthService();
    const recordResult = await recordHealthSnapshot(snapshot, { now });
    runtimeStatus.lastRunAt = now.toISOString();
    runtimeStatus.lastRunStatus = recordResult.ok ? 'ok' : (recordResult.reason || 'skipped');
    return { ok: true, snapshot, recordResult };
  } catch (error) {
    runtimeStatus.lastRunAt = now.toISOString();
    runtimeStatus.lastRunStatus = 'failed';
    try { logger.warn?.('[NEWS_PULSE_ENGINE][monitoring] run failed', { message: error?.message || String(error) }); } catch (_) {}
    return { ok: false, error: error?.message || String(error) };
  } finally {
    monitoringInFlight = false;
  }
}

function isMonitoringEnabled(env = process.env) {
  if (isTestLike(env)) return false;
  const flag = String(env.NEWS_PULSE_MONITORING_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'disabled', 'no'].includes(flag)) return false;
  if (['1', 'true', 'on', 'enabled', 'yes'].includes(flag)) return true;
  return isProductionLike(env);
}

function startNewsPulseEngineMonitoring(options = {}) {
  const env = options.env || process.env;
  const enabled = isMonitoringEnabled(env);
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs || DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  configuredIntervalMs = intervalMs;
  runtimeStatus.enabled = enabled;

  if (!enabled) {
    runtimeStatus.running = false;
    return { started: false, reason: 'disabled' };
  }

  if (monitoringTimer) {
    runtimeStatus.running = true;
    return { started: false, reason: 'already_started' };
  }

  const runOptions = { healthService: options.healthService, logger: options.logger || console };
  monitoringTimer = setInterval(() => {
    runMonitoringOnce(runOptions).catch(() => null);
  }, intervalMs);
  if (typeof monitoringTimer.unref === 'function') monitoringTimer.unref();

  runtimeStatus.running = true;
  if (options.runImmediately !== false) {
    runMonitoringOnce(runOptions).catch(() => null);
  }

  return { started: true, intervalMs };
}

function stopNewsPulseEngineMonitoring() {
  if (monitoringTimer) clearInterval(monitoringTimer);
  monitoringTimer = null;
  runtimeStatus.running = false;
}

function getMonitoringStatus(env = process.env) {
  return {
    enabled: runtimeStatus.running || isMonitoringEnabled(env),
    running: runtimeStatus.running,
    intervalMinutes: Math.round((configuredIntervalMs / 60000) * 100) / 100,
    lastRunAt: runtimeStatus.lastRunAt,
    lastRunStatus: runtimeStatus.lastRunStatus,
  };
}

function normalizeIncident(doc) {
  if (!doc) return null;
  const id = doc._id || doc.id;
  return {
    id: id ? String(id) : null,
    checkId: doc.checkId || null,
    area: doc.area || null,
    status: doc.status || null,
    state: doc.state || null,
    message: doc.message || '',
    recommendation: doc.recommendation || '',
    startedAt: doc.startedAt ? new Date(doc.startedAt).toISOString() : null,
    lastSeenAt: doc.lastSeenAt ? new Date(doc.lastSeenAt).toISOString() : null,
    resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt).toISOString() : null,
    durationMs: typeof doc.durationMs === 'number' ? doc.durationMs : null,
  };
}

async function listIncidents({ status = 'open', limit = 50 } = {}) {
  if (!isDbReady()) return { ok: false, status: 503, message: 'Database unavailable', incidents: [] };

  const statusNorm = String(status || 'open').trim().toLowerCase();
  const filter = {};
  if (statusNorm === 'open' || statusNorm === 'resolved') filter.state = statusNorm;
  else if (statusNorm !== 'all') filter.state = 'open';

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const docs = await NewsPulseIncident.find(filter).sort({ startedAt: -1 }).limit(safeLimit).lean();
  return { ok: true, status: 200, incidents: (docs || []).map(normalizeIncident) };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  LATEST_STATE_KEY,
  RESOLVED_RETENTION_MS,
  getMonitoringStatus,
  isIncidentEligible,
  isKnownConfigurationOnlyCheck,
  isMonitoringEnabled,
  isDuplicateKeyError,
  listIncidents,
  recordHealthSnapshot,
  runMonitoringOnce,
  startNewsPulseEngineMonitoring,
  stopNewsPulseEngineMonitoring,
};