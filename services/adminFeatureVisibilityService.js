const SiteSettings = require('../models/SiteSettings');
const {
  CANONICAL_ADMIN_MODULE_KEYS,
  getFounderModulePolicy,
  patchFromLegacyVisibility,
  updateFounderModulePolicy,
  visibilityFromPolicy,
} = require('./founderAccessPolicyService');

const ADMIN_FEATURE_VISIBILITY_KEY = 'adminFeatureVisibility';

const ADMIN_FEATURE_VISIBILITY_KEYS = Object.freeze(CANONICAL_ADMIN_MODULE_KEYS.filter((key) => key !== 'safeZone'));

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
  const policy = await getFounderModulePolicy();
  return normalizeAdminFeatureVisibility(visibilityFromPolicy(policy));
}

async function saveAdminFeatureVisibility(patch, actor = null, auditReason = 'Legacy Safe Zone visibility update') {
  const mapped = patchFromLegacyVisibility(patch || {});
  if (mapped.invalidKeys.length || mapped.invalidValueKeys.length) {
    const error = new Error('Invalid admin feature visibility payload');
    error.invalidKeys = mapped.invalidKeys;
    error.invalidValueKeys = mapped.invalidValueKeys;
    throw error;
  }

  const currentPolicy = await getFounderModulePolicy();
  const result = await updateFounderModulePolicy({ modulePolicies: mapped.patch, auditReason, expectedVersion: currentPolicy.version }, actor);
  if (!result.ok) {
    const error = new Error(result.message || 'Failed to save admin feature visibility');
    error.result = result;
    throw error;
  }

  const settings = await getOrCreateSiteSettings();
  const current = normalizeAdminFeatureVisibility(settings?.[ADMIN_FEATURE_VISIBILITY_KEY]);
  settings[ADMIN_FEATURE_VISIBILITY_KEY] = {
    ...current,
    ...patch,
  };
  await settings.save();
  return normalizeAdminFeatureVisibility(visibilityFromPolicy(result.policy));
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