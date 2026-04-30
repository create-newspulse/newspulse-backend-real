const mongoose = require('mongoose');

const SystemSetting = require('../models/SystemSetting');

const VIRAL_VIDEOS_SETTINGS_KEY = 'viral_videos_settings';
const DEFAULT_VIRAL_VIDEOS_SETTINGS = Object.freeze({
  viralVideosFrontendEnabled: true,
  frontendEnabled: true,
  viralVideosCloudUploadEnabled: false,
});

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return fallback;
}

function normalizeViralVideosSettings(value, fallback = DEFAULT_VIRAL_VIDEOS_SETTINGS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const frontendEnabled = normalizeBoolean(
    source.viralVideosFrontendEnabled,
    normalizeBoolean(source.frontendEnabled, fallback.viralVideosFrontendEnabled)
  );
  return {
    viralVideosFrontendEnabled: frontendEnabled,
    frontendEnabled,
    viralVideosCloudUploadEnabled: normalizeBoolean(source.viralVideosCloudUploadEnabled, fallback.viralVideosCloudUploadEnabled),
  };
}

async function getViralVideosSettings() {
  if (!isDbReady()) {
    return { ...DEFAULT_VIRAL_VIDEOS_SETTINGS };
  }

  const doc = await SystemSetting.findOne({ key: VIRAL_VIDEOS_SETTINGS_KEY }).lean();
  if (!doc || !doc.value || typeof doc.value !== 'object') {
    return { ...DEFAULT_VIRAL_VIDEOS_SETTINGS };
  }

  return normalizeViralVideosSettings(doc.value);
}

async function saveViralVideosSettings(input, admin) {
  const settings = normalizeViralVideosSettings(input);

  if (!isDbReady()) {
    return settings;
  }

  const updatedBy = {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };

  const doc = await SystemSetting.findOneAndUpdate(
    { key: VIRAL_VIDEOS_SETTINGS_KEY },
    { $set: { key: VIRAL_VIDEOS_SETTINGS_KEY, value: settings, updatedBy } },
    { upsert: true, new: true }
  ).lean();

  return normalizeViralVideosSettings(doc && doc.value ? doc.value : settings);
}

async function isViralVideosFrontendEnabled() {
  const settings = await getViralVideosSettings();
  return settings.viralVideosFrontendEnabled !== false;
}

module.exports = {
  VIRAL_VIDEOS_SETTINGS_KEY,
  DEFAULT_VIRAL_VIDEOS_SETTINGS,
  getViralVideosSettings,
  saveViralVideosSettings,
  isViralVideosFrontendEnabled,
  normalizeViralVideosSettings,
};