const mongoose = require('mongoose');

const SystemSetting = require('../models/SystemSetting');
const { getEffectiveCommunityAccessState } = require('./communityAccessToggleService');

const ADMIN_SETTINGS_KEY = 'settings_center_admin';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function dbStatusPayload() {
  const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  const connected = readyState === 1;
  const name = connected && mongoose?.connection?.name ? String(mongoose.connection.name) : null;
  return {
    connected,
    readyState,
    ...(name ? { name } : {}),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = { ...(isPlainObject(base) ? base : {}) };
  if (!isPlainObject(override)) return out;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (isPlainObject(value)) {
      out[key] = deepMerge({}, value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice();
    } else {
      out[key] = value;
    }
  }

  return out;
}

async function getDefaultFounderFeatureToggles() {
  const effective = await getEffectiveCommunityAccessState();
  return {
    communityReporterClosed: effective.communityReporterClosed,
    reporterPortalClosed: effective.reporterPortalClosed,
    communityReporterEnabled: effective.communityReporterEnabled,
    reporterPortalEnabled: effective.reporterPortalEnabled,
    updatedAt: effective.updatedAt || null,
  };
}

function getDefaultAiTrainingInfo() {
  return {
    lastUpdatedAt: null,
    sources: [],
    notes: '',
  };
}

async function getDefaultFounderSettings() {
  return {
    sections: {},
    adminPanel: {},
    featureToggles: await getDefaultFounderFeatureToggles(),
    aiTrainingInfo: getDefaultAiTrainingInfo(),
  };
}

function pickObject(value) {
  return isPlainObject(value) ? value : {};
}

function extractFeatureTogglePatch(payload) {
  const root = pickObject(payload);
  const nested = pickObject(root.featureToggles);
  const dataNested = pickObject(pickObject(root.data).featureToggles);
  const source = Object.keys(nested).length ? nested : (Object.keys(dataNested).length ? dataNested : root);

  const patch = {};
  if (typeof source.communityReporterClosed === 'boolean') {
    patch.communityReporterClosed = source.communityReporterClosed;
  }
  if (typeof source.reporterPortalClosed === 'boolean') {
    patch.reporterPortalClosed = source.reporterPortalClosed;
  }
  return patch;
}

function sanitizeAiTrainingInfo(value) {
  return deepMerge(getDefaultAiTrainingInfo(), pickObject(value));
}

function sanitizeStoredFounderSettings(value) {
  const root = pickObject(value);
  const dataRoot = pickObject(root.data);
  const mergedRoot = Object.keys(dataRoot).length ? deepMerge(root, dataRoot) : root;

  const sanitized = deepMerge({}, mergedRoot);
  delete sanitized.data;
  delete sanitized.featureToggles;

  sanitized.sections = pickObject(sanitized.sections);
  sanitized.adminPanel = pickObject(sanitized.adminPanel);
  sanitized.aiTrainingInfo = sanitizeAiTrainingInfo(sanitized.aiTrainingInfo);

  return sanitized;
}

async function loadFounderSettingsBundle() {
  const db = dbStatusPayload();
  const defaults = await getDefaultFounderSettings();

  if (!db.connected) {
    return {
      data: defaults,
      updatedAt: null,
      db,
      source: 'default',
    };
  }

  const doc = await SystemSetting.findOne({ key: ADMIN_SETTINGS_KEY }).lean();
  const stored = sanitizeStoredFounderSettings(doc?.value);
  const data = deepMerge(defaults, stored);
  data.featureToggles = defaults.featureToggles;
  data.aiTrainingInfo = sanitizeAiTrainingInfo(stored.aiTrainingInfo);

  return {
    data,
    updatedAt: doc?.updatedAt || null,
    db,
    source: doc ? 'db' : 'default',
  };
}

async function getFounderAiTrainingInfo() {
  const bundle = await loadFounderSettingsBundle();
  return {
    aiTrainingInfo: isPlainObject(bundle.data?.aiTrainingInfo)
      ? deepMerge(getDefaultAiTrainingInfo(), bundle.data.aiTrainingInfo)
      : getDefaultAiTrainingInfo(),
    updatedAt: bundle.updatedAt,
    db: bundle.db,
    source: bundle.source,
  };
}

async function writeFounderSettingsBundle(payload, admin) {
  const db = dbStatusPayload();
  if (!db.connected) {
    return {
      ok: false,
      status: 503,
      message: 'DB unavailable',
      db,
    };
  }

  const sanitized = sanitizeStoredFounderSettings(payload);
  const updatedBy = {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };

  const existing = await SystemSetting.findOne({ key: ADMIN_SETTINGS_KEY }).lean();
  const existingSanitized = sanitizeStoredFounderSettings(existing?.value);
  const nextValue = deepMerge(existingSanitized, sanitized);

  const doc = await SystemSetting.findOneAndUpdate(
    { key: ADMIN_SETTINGS_KEY },
    { $set: { key: ADMIN_SETTINGS_KEY, value: nextValue, updatedBy } },
    { new: true, upsert: true }
  ).lean();

  return {
    ok: true,
    status: 200,
    updatedAt: doc?.updatedAt || null,
    db,
  };
}

module.exports = {
  extractFeatureTogglePatch,
  getDefaultAiTrainingInfo,
  getDefaultFounderSettings,
  getDefaultFounderFeatureToggles,
  sanitizeStoredFounderSettings,
  writeFounderSettingsBundle,
  loadFounderSettingsBundle,
  getFounderAiTrainingInfo,
};