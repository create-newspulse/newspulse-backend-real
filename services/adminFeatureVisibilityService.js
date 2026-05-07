const SiteSettings = require('../models/SiteSettings');

const ADMIN_FEATURE_VISIBILITY_KEY = 'adminFeatureVisibility';

const ADMIN_FEATURE_VISIBILITY_KEYS = Object.freeze([
  'addNews',
  'manageNews',
  'draftDesk',
  'communityReporterQueue',
  'reporterPortalAdmin',
  'broadcastCenter',
  'adsManager',
  'media',
  'viralVideos',
  'aira',
  'liveTv',
  'editorial',
  'seo',
  'analytics',
  'moderation',
  'aiEngine',
  'settings',
]);

function getDefaultAdminFeatureVisibility() {
  return ADMIN_FEATURE_VISIBILITY_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});
}

function normalizeAdminFeatureVisibility(input) {
  const defaults = getDefaultAdminFeatureVisibility();
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const key of ADMIN_FEATURE_VISIBILITY_KEYS) {
    if (typeof raw[key] === 'boolean') {
      defaults[key] = raw[key];
    }
  }

  return defaults;
}

function extractAdminFeatureVisibilityPatch(body) {
  const source = body && typeof body.visibility === 'object' && !Array.isArray(body.visibility)
    ? body.visibility
    : body;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { patch: null, invalidKeys: [], invalidValueKeys: [] };
  }

  const patch = {};
  const invalidKeys = [];
  const invalidValueKeys = [];

  for (const [key, value] of Object.entries(source)) {
    if (!ADMIN_FEATURE_VISIBILITY_KEYS.includes(key)) {
      invalidKeys.push(key);
      continue;
    }
    if (typeof value !== 'boolean') {
      invalidValueKeys.push(key);
      continue;
    }
    patch[key] = value;
  }

  return { patch, invalidKeys, invalidValueKeys };
}

async function getOrCreateSiteSettings() {
  let settings = await SiteSettings.findOne();
  if (!settings) {
    settings = await SiteSettings.create({
      [ADMIN_FEATURE_VISIBILITY_KEY]: getDefaultAdminFeatureVisibility(),
    });
  }
  return settings;
}

async function getAdminFeatureVisibility() {
  const settings = await getOrCreateSiteSettings();
  return normalizeAdminFeatureVisibility(settings?.[ADMIN_FEATURE_VISIBILITY_KEY]);
}

async function saveAdminFeatureVisibility(patch) {
  const settings = await getOrCreateSiteSettings();
  const current = normalizeAdminFeatureVisibility(settings?.[ADMIN_FEATURE_VISIBILITY_KEY]);
  settings[ADMIN_FEATURE_VISIBILITY_KEY] = {
    ...current,
    ...patch,
  };
  await settings.save();
  return normalizeAdminFeatureVisibility(settings[ADMIN_FEATURE_VISIBILITY_KEY]);
}

module.exports = {
  ADMIN_FEATURE_VISIBILITY_KEY,
  ADMIN_FEATURE_VISIBILITY_KEYS,
  extractAdminFeatureVisibilityPatch,
  getAdminFeatureVisibility,
  getDefaultAdminFeatureVisibility,
  normalizeAdminFeatureVisibility,
  saveAdminFeatureVisibility,
};