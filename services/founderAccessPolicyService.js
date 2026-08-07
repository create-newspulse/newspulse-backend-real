const SiteSettings = require('../models/SiteSettings');
const mongoose = require('mongoose');
const { normalizeRole } = require('../lib/teamAccess');

const MODULE_POLICY_STATES = Object.freeze(['available', 'hidden', 'staff_locked', 'founder_only']);
const STAFF_ACCESS_STATES = Object.freeze(['enabled', 'disabled', 'temporary']);
const ACCESS_REASON_CODES = Object.freeze([
  'ALLOWED',
  'MODULE_HIDDEN',
  'STAFF_ACCESS_DISABLED',
  'GLOBAL_STAFF_LOCK',
  'FOUNDER_ONLY',
  'TEMPORARY_ACCESS_EXPIRED',
  'ACCOUNT_EXPIRED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_INACTIVE',
]);

const CANONICAL_ADMIN_MODULE_KEYS = Object.freeze([
  'addNews',
  'manageNews',
  'draftDesk',
  'communityReporterQueue',
  'reporterPortalAdmin',
  'broadcastCenter',
  'adsManager',
  'financeDesk',
  'media',
  'viralVideos',
  'aira',
  'liveTv',
  'editorial',
  'seo',
  'analytics',
  'moderation',
  'complianceReports',
  'dpdpCompliance',
  'aiEngine',
  'settings',
  'safeZone',
  'staffTasks',
  'auditLogs',
]);

const CANONICAL_STAFF_MODULE_KEYS = Object.freeze([
  'dashboard',
  ...CANONICAL_ADMIN_MODULE_KEYS,
]);

const FIXED_ADMIN_CONTROL_KEYS = Object.freeze(['dashboard', 'myAccount', 'darkMode', 'logout']);

const LEGACY_MODULE_TO_CANONICAL = Object.freeze({
  add_news: 'addNews',
  manage_news: 'manageNews',
  draft_desk: 'draftDesk',
  community_reporter_queue: 'communityReporterQueue',
  reporter_portal_admin: 'reporterPortalAdmin',
  broadcast_center: 'broadcastCenter',
  ads_manager: 'adsManager',
  finance_desk: 'financeDesk',
  media: 'media',
  viral_videos: 'viralVideos',
  aira: 'aira',
  live_tv: 'liveTv',
  editorial: 'editorial',
  seo: 'seo',
  analytics: 'analytics',
  moderation: 'moderation',
  compliance_reports: 'complianceReports',
  dpdp_compliance: 'dpdpCompliance',
  ai_engine: 'aiEngine',
  settings: 'settings',
  safe_zone: 'safeZone',
  staff_tasks: 'staffTasks',
  audit_logs: 'auditLogs',
});

const CANONICAL_TO_LEGACY_MODULE = Object.freeze(Object.entries(LEGACY_MODULE_TO_CANONICAL).reduce((acc, [legacyKey, canonicalKey]) => {
  acc[canonicalKey] = legacyKey;
  return acc;
}, {}));

const CANONICAL_MODULE_SET = new Set(CANONICAL_STAFF_MODULE_KEYS);
const POLICY_STATE_SET = new Set(MODULE_POLICY_STATES);
const STAFF_ACCESS_STATE_SET = new Set(STAFF_ACCESS_STATES);
const BULK_FOUNDER_ONLY_ACTION = 'set_all_configurable_modules_founder_only';
const BULK_FOUNDER_ONLY_CONFIRMATION = 'SET_ALL_CONFIGURABLE_MODULES_FOUNDER_ONLY';
const MODULE_POLICY_CONFLICT_MESSAGE = 'Founder Access Control settings changed since this page was loaded.';

function policyServiceError(status, code, message, extra = {}) {
  return { ok: false, success: false, status, code, message, ...extra };
}

function publicModulePolicy(policy) {
  return {
    modulePolicies: policy.modulePolicies,
    auditReason: policy.auditReason || null,
  };
}

function modulePolicyEnvelope(policy, extra = {}) {
  return {
    ok: true,
    success: true,
    policy: publicModulePolicy(policy),
    version: policy.version,
    updatedAt: policy.updatedAt || null,
    updatedBy: policy.updatedBy || null,
    ...extra,
  };
}

function isFounderAccount(user) {
  return Boolean(user?.isFounder || normalizeRole(user?.role) === 'founder');
}

function moduleAliasKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const MODULE_KEY_ALIASES = Object.freeze({
  [moduleAliasKey('dashboard')]: 'dashboard',
  [moduleAliasKey('DPDP Privacy Requests')]: 'dpdpCompliance',
  [moduleAliasKey('DPDP Privacy Request')]: 'dpdpCompliance',
  [moduleAliasKey('DPDP Compliance')]: 'dpdpCompliance',
  [moduleAliasKey('Data Privacy Requests')]: 'dpdpCompliance',
  [moduleAliasKey('AI Engine')]: 'aiEngine',
  [moduleAliasKey('A.I. Engine')]: 'aiEngine',
  [moduleAliasKey('Settings')]: 'settings',
  [moduleAliasKey('Safe Zone')]: 'safeZone',
  [moduleAliasKey('Add News')]: 'addNews',
  [moduleAliasKey('Manage News')]: 'manageNews',
  [moduleAliasKey('Draft Desk')]: 'draftDesk',
  [moduleAliasKey('Community Reporter Queue')]: 'communityReporterQueue',
  [moduleAliasKey('Reporter Portal Admin')]: 'reporterPortalAdmin',
  [moduleAliasKey('Broadcast Center')]: 'broadcastCenter',
  [moduleAliasKey('Ads Manager')]: 'adsManager',
  [moduleAliasKey('Finance Desk')]: 'financeDesk',
  [moduleAliasKey('Viral Videos')]: 'viralVideos',
  [moduleAliasKey('Live TV')]: 'liveTv',
  [moduleAliasKey('Compliance Reports')]: 'complianceReports',
  [moduleAliasKey('Staff Tasks')]: 'staffTasks',
  [moduleAliasKey('Audit Logs')]: 'auditLogs',
});

function canonicalModuleKey(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (CANONICAL_MODULE_SET.has(raw)) return raw;
  if (options.allowLegacy && LEGACY_MODULE_TO_CANONICAL[raw]) return LEGACY_MODULE_TO_CANONICAL[raw];
  if (options.allowAliases) {
    const alias = MODULE_KEY_ALIASES[moduleAliasKey(raw)];
    if (alias) return alias;
  }
  return null;
}

function defaultModulePolicies() {
  return CANONICAL_ADMIN_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = 'founder_only';
    return acc;
  }, {});
}

function normalizeModulePolicies(input) {
  const out = defaultModulePolicies();
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const [key, value] of Object.entries(raw)) {
    const canonicalKey = canonicalModuleKey(key);
    if (!canonicalKey || canonicalKey === 'safeZone') continue;
    const state = String(value || '').trim();
    if (!POLICY_STATE_SET.has(state)) continue;
    out[canonicalKey] = state;
  }

  out.safeZone = 'founder_only';
  return out;
}

function modulePoliciesFromLegacyVisibility(visibility) {
  const out = defaultModulePolicies();
  const raw = visibility && typeof visibility === 'object' && !Array.isArray(visibility) ? visibility : {};

  for (const [key, value] of Object.entries(raw)) {
    const canonicalKey = canonicalModuleKey(key, { allowLegacy: true });
    if (!canonicalKey || canonicalKey === 'safeZone') continue;
    if (typeof value === 'boolean') out[canonicalKey] = value ? 'available' : 'hidden';
  }

  out.safeZone = 'founder_only';
  return out;
}

function normalizeStoredPolicy(settings) {
  const stored = settings?.adminModulePolicy && typeof settings.adminModulePolicy === 'object' && !Array.isArray(settings.adminModulePolicy)
    ? settings.adminModulePolicy
    : null;
  const modulePolicies = stored?.modulePolicies
    ? normalizeModulePolicies(stored.modulePolicies)
    : modulePoliciesFromLegacyVisibility(settings?.adminFeatureVisibility);
  const version = Number.isFinite(Number(stored?.version)) && Number(stored.version) > 0 ? Number(stored.version) : 1;

  return {
    modulePolicies,
    version,
    updatedAt: stored?.updatedAt || settings?.updatedAt || null,
    updatedBy: stored?.updatedBy || null,
    auditReason: stored?.auditReason || null,
  };
}

function hasPositiveStoredVersion(policy) {
  const version = Number(policy?.version);
  return Number.isInteger(version) && version > 0;
}

async function persistPolicyUpgrade(settings, policy) {
  if (!settings) return null;
  if (settings._id && typeof SiteSettings.findOneAndUpdate === 'function') {
    const updated = await SiteSettings.findOneAndUpdate(
      { _id: settings._id },
      { $set: { adminModulePolicy: policy } },
      { new: true, runValidators: false },
    );
    if (updated) return updated;
  }

  if (typeof settings.save === 'function') {
    settings.adminModulePolicy = policy;
    return settings.save();
  }

  settings.adminModulePolicy = policy;
  return settings;
}

async function normalizeAndUpgradeStoredPolicy(settings) {
  const normalized = normalizeStoredPolicy(settings);
  const stored = settings?.adminModulePolicy && typeof settings.adminModulePolicy === 'object' && !Array.isArray(settings.adminModulePolicy)
    ? settings.adminModulePolicy
    : null;
  const needsVersionUpgrade = settings && (!stored || !hasPositiveStoredVersion(stored));
  if (!needsVersionUpgrade) return normalized;

  const upgradedPolicy = {
    modulePolicies: normalized.modulePolicies,
    version: 1,
    updatedAt: normalized.updatedAt || new Date(),
    updatedBy: normalized.updatedBy || null,
    auditReason: normalized.auditReason || (stored ? 'Legacy module policy version initialized' : 'Legacy feature visibility policy initialized'),
  };
  const updatedSettings = await persistPolicyUpgrade(settings, upgradedPolicy);
  return normalizeStoredPolicy(updatedSettings || { ...settings, adminModulePolicy: upgradedPolicy });
}

async function getOrCreateSiteSettings() {
  let settings = await SiteSettings.findOne();
  if (!settings) {
    settings = await SiteSettings.create({
      adminFeatureVisibility: {},
      adminModulePolicy: {
        modulePolicies: defaultModulePolicies(),
        version: 1,
        updatedAt: new Date(),
        updatedBy: null,
        auditReason: 'Initial default policy',
      },
    });
  }
  return settings;
}

async function getFounderModulePolicy() {
  if (arguments[0]?.defaultWhenDbUnavailable && !(mongoose.connection && mongoose.connection.db)) {
    return normalizeStoredPolicy(null);
  }
  const settings = await getOrCreateSiteSettings();
  return normalizeAndUpgradeStoredPolicy(settings);
}

function validatePolicyPatch(input) {
  const source = input && typeof input.modulePolicies === 'object' && !Array.isArray(input.modulePolicies)
    ? input.modulePolicies
    : input;
  const patch = {};
  const invalidKeys = [];
  const invalidStateKeys = [];

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { patch, invalidKeys, invalidStateKeys };
  }

  for (const [key, value] of Object.entries(source)) {
    const canonicalKey = canonicalModuleKey(key);
    if (!canonicalKey) {
      invalidKeys.push(key);
      continue;
    }
    const state = String(value || '').trim();
    if (!POLICY_STATE_SET.has(state)) {
      invalidStateKeys.push(key);
      continue;
    }
    patch[canonicalKey] = canonicalKey === 'safeZone' ? 'founder_only' : state;
  }

  return { patch, invalidKeys, invalidStateKeys };
}

function requireAuditReason(input) {
  const reason = String(input?.auditReason || input?.reason || '').trim();
  return reason.length >= 3 ? reason.slice(0, 500) : null;
}

function readExpectedVersion(input) {
  if (!Object.prototype.hasOwnProperty.call(input || {}, 'expectedVersion')) {
    return { error: policyServiceError(400, 'MODULE_POLICY_VERSION_REQUIRED', 'expectedVersion is required') };
  }
  const raw = input.expectedVersion;
  if (raw === undefined || raw === null || raw === '') {
    return { error: policyServiceError(400, 'MODULE_POLICY_VERSION_REQUIRED', 'expectedVersion is required') };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { error: policyServiceError(400, 'MODULE_POLICY_VERSION_INVALID', 'expectedVersion must be a positive integer') };
  }
  return { value };
}

function isBulkFounderOnlyRequest(input) {
  const action = String(input?.bulkAction || input?.action || '').trim();
  return action === BULK_FOUNDER_ONLY_ACTION;
}

function buildBulkFounderOnlyPatch() {
  return CANONICAL_ADMIN_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = 'founder_only';
    return acc;
  }, {});
}

function buildPolicyPatch(input) {
  let validation;
  let bulkAction = null;

  if (isBulkFounderOnlyRequest(input || {})) {
    const confirmation = String(input?.confirmation || input?.confirm || '').trim();
    if (confirmation !== BULK_FOUNDER_ONLY_CONFIRMATION) {
      return { error: policyServiceError(400, 'MODULE_POLICY_VALIDATION_FAILED', 'Valid bulk-action confirmation is required', { validationErrors: ['bulkConfirmationRequired'] }) };
    }
    bulkAction = BULK_FOUNDER_ONLY_ACTION;
    validation = { patch: buildBulkFounderOnlyPatch(), invalidKeys: [], invalidStateKeys: [] };
  } else {
    validation = validatePolicyPatch(input || {});
  }

  if (validation.invalidKeys.length || validation.invalidStateKeys.length) {
    return {
      error: policyServiceError(400, 'MODULE_POLICY_VALIDATION_FAILED', 'Invalid module policy payload', {
        invalidKeys: validation.invalidKeys,
        invalidStateKeys: validation.invalidStateKeys,
      }),
    };
  }

  const affectedModuleKeys = Object.keys(validation.patch);
  if (!affectedModuleKeys.length) {
    return { error: policyServiceError(400, 'MODULE_POLICY_VALIDATION_FAILED', 'At least one module policy change is required', { validationErrors: ['modulePolicyChangesRequired'] }) };
  }

  return { patch: validation.patch, bulkAction, affectedModuleKeys };
}

function validatePolicyWriteContract(input) {
  const expected = readExpectedVersion(input || {});
  if (expected.error) return { error: expected.error };

  const reason = requireAuditReason(input);
  if (!reason) {
    return { error: policyServiceError(400, 'MODULE_POLICY_VALIDATION_FAILED', 'auditReason is required', { validationErrors: ['auditReasonRequired'] }) };
  }

  const policyPatch = buildPolicyPatch(input || {});
  if (policyPatch.error) return { error: policyPatch.error };

  return { expectedVersion: expected.value, reason, ...policyPatch };
}

function validatePolicyPreviewContract(input) {
  const expected = readExpectedVersion(input || {});
  if (expected.error) return { error: expected.error };
  const policyPatch = buildPolicyPatch(input || {});
  if (policyPatch.error) return { error: policyPatch.error };
  return { expectedVersion: expected.value, ...policyPatch };
}

async function updateFounderModulePolicy(input, actor, options = {}) {
  void options;
  const contract = validatePolicyWriteContract(input || {});
  if (contract.error) return contract.error;

  const settings = await getOrCreateSiteSettings();
  const previous = await normalizeAndUpgradeStoredPolicy(settings);
  if (contract.expectedVersion !== previous.version) {
    return policyServiceError(409, 'MODULE_POLICY_VERSION_CONFLICT', MODULE_POLICY_CONFLICT_MESSAGE, { currentVersion: previous.version });
  }

  const modulePolicies = normalizeModulePolicies({ ...previous.modulePolicies, ...contract.patch, safeZone: 'founder_only' });
  const nextPolicy = {
    modulePolicies,
    version: contract.expectedVersion + 1,
    updatedAt: new Date(),
    updatedBy: actor?.id || actor?._id || actor?.email || null,
    auditReason: contract.reason,
  };

  let updatedSettings = null;
  if (settings?._id && typeof SiteSettings.findOneAndUpdate === 'function') {
    updatedSettings = await SiteSettings.findOneAndUpdate(
      { _id: settings._id, 'adminModulePolicy.version': contract.expectedVersion },
      { $set: { adminModulePolicy: nextPolicy } },
      { new: true, runValidators: false },
    );
  } else if (previous.version === contract.expectedVersion && typeof settings?.save === 'function') {
    const priorPolicy = settings.adminModulePolicy;
    settings.adminModulePolicy = nextPolicy;
    try {
      updatedSettings = await settings.save();
    } catch (error) {
      settings.adminModulePolicy = priorPolicy;
      throw error;
    }
  }

  if (!updatedSettings) {
    const current = await getFounderModulePolicy();
    return policyServiceError(409, 'MODULE_POLICY_VERSION_CONFLICT', MODULE_POLICY_CONFLICT_MESSAGE, { currentVersion: current.version });
  }

  const savedPolicy = normalizeStoredPolicy(updatedSettings);

  return {
    ok: true,
    success: true,
    previous,
    policy: savedPolicy,
    version: savedPolicy.version,
    updatedAt: savedPolicy.updatedAt || null,
    updatedBy: savedPolicy.updatedBy || null,
    bulkAction: contract.bulkAction,
    affectedModuleKeys: contract.affectedModuleKeys,
    changed: contract.affectedModuleKeys.reduce((acc, key) => {
      acc[key] = { previous: previous.modulePolicies[key], next: modulePolicies[key] };
      return acc;
    }, {}),
  };
}

async function previewFounderModulePolicy(input) {
  const contract = validatePolicyPreviewContract(input || {});
  if (contract.error) return contract.error;

  const current = await getFounderModulePolicy();
  if (contract.expectedVersion !== current.version) {
    return policyServiceError(409, 'MODULE_POLICY_VERSION_CONFLICT', MODULE_POLICY_CONFLICT_MESSAGE, { currentVersion: current.version });
  }

  const preview = {
    ...current,
    modulePolicies: normalizeModulePolicies({ ...current.modulePolicies, ...contract.patch, safeZone: 'founder_only' }),
  };

  return modulePolicyEnvelope(current, {
    current: publicModulePolicy(current),
    preview: publicModulePolicy(preview),
    bulkAction: contract.bulkAction,
    affectedModuleKeys: contract.affectedModuleKeys,
  });
}

function visibilityFromPolicy(policy) {
  const normalized = normalizeModulePolicies(policy?.modulePolicies || policy);
  const visibility = {};
  for (const key of CANONICAL_ADMIN_MODULE_KEYS) {
    if (key === 'safeZone') continue;
    visibility[key] = normalized[key] === 'available' || normalized[key] === 'staff_locked';
  }
  return visibility;
}

function patchFromLegacyVisibility(source) {
  const patch = {};
  const invalidKeys = [];
  const invalidValueKeys = [];

  for (const [key, value] of Object.entries(source || {})) {
    const canonicalKey = canonicalModuleKey(key);
    if (!canonicalKey || canonicalKey === 'safeZone') {
      invalidKeys.push(key);
      continue;
    }
    if (typeof value !== 'boolean') {
      invalidValueKeys.push(key);
      continue;
    }
    patch[canonicalKey] = value ? 'available' : 'hidden';
  }

  return { patch, invalidKeys, invalidValueKeys };
}

function accountBlockReason(user, now = new Date()) {
  if (!user) return 'ACCOUNT_INACTIVE';
  const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
  const userStatus = String(user.status || accountStatus || 'active').toLowerCase();

  if (user.isDeleted || user.deletedAt || ['archived', 'deleted', 'deleted_test'].includes(accountStatus) || ['archived', 'deleted', 'deleted_test'].includes(userStatus)) return 'ACCOUNT_INACTIVE';
  if (accountStatus === 'suspended' || userStatus === 'suspended') return 'ACCOUNT_SUSPENDED';
  if (accountStatus === 'locked' || userStatus === 'locked' || (user.lockedUntil && new Date(user.lockedUntil) > now)) return 'ACCOUNT_LOCKED';
  if (accountStatus === 'expired' || userStatus === 'expired' || (user.noExpiry !== true && user.accessExpiresAt && new Date(user.accessExpiresAt) <= now)) return 'ACCOUNT_EXPIRED';
  if (user.loginAllowed === false) return 'ACCOUNT_INACTIVE';
  return null;
}

function normalizeStaffModuleStates(value) {
  const out = {};
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const [key, valueState] of Object.entries(raw)) {
    const canonicalKey = canonicalModuleKey(key, { allowLegacy: true });
    const state = normalizeStaffAccessState(valueState);
    if (!canonicalKey || !STAFF_ACCESS_STATE_SET.has(state)) continue;
    out[canonicalKey] = state;
  }
  return out;
}

function normalizeStaffAccessState(value) {
  if (value === true || value === 1) return 'enabled';
  if (value === false || value === 0) return 'disabled';
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (raw === 'on' || raw === 'yes' || raw === 'allowed' || raw === 'allow') return 'enabled';
  if (raw === 'off' || raw === 'no' || raw === 'denied' || raw === 'deny' || raw === 'not_allowed') return 'disabled';
  if (STAFF_ACCESS_STATE_SET.has(raw)) return raw;
  return null;
}

function moduleAccessValueState(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, 'individualState')) return value.individualState;
    if (Object.prototype.hasOwnProperty.call(value, 'state')) return value.state;
    if (Object.prototype.hasOwnProperty.call(value, 'accessState')) return value.accessState;
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
    if (Object.prototype.hasOwnProperty.call(value, 'enabled')) return value.enabled;
  }
  return value;
}

function moduleAccessValidationError(field, reason, extra = {}) {
  return { field, reason, ...extra };
}

function parseStaffModuleAccessPayload(body) {
  const source = body?.moduleAccessStates ?? body?.moduleStates ?? body?.modules ?? body?.moduleAccess ?? body?.moduleAccessOverride;
  if (source === undefined) return { provided: false, states: {}, enabledLegacyKeys: [], errors: [] };

  const states = {};
  const errors = [];

  if (Array.isArray(source)) {
    source.forEach((rawKey, index) => {
      const key = String(rawKey || '').trim();
      const canonicalKey = canonicalModuleKey(key, { allowLegacy: true, allowAliases: true });
      const field = `moduleAccess[${index}]`;
      if (!canonicalKey) {
        errors.push(moduleAccessValidationError(field, 'UNKNOWN_MODULE_KEY', { key }));
        return;
      }
      if (canonicalKey === 'safeZone') {
        errors.push(moduleAccessValidationError(field, 'FOUNDER_ONLY_MODULE', { key, canonicalKey }));
        return;
      }
      states[canonicalKey] = 'enabled';
    });
  } else if (source && typeof source === 'object') {
    for (const [rawKey, rawValue] of Object.entries(source)) {
      const canonicalKey = canonicalModuleKey(rawKey, { allowLegacy: true, allowAliases: true });
      const field = `moduleAccess.${rawKey}`;
      if (!canonicalKey) {
        errors.push(moduleAccessValidationError(field, 'UNKNOWN_MODULE_KEY', { key: rawKey }));
        continue;
      }
      const stateValue = moduleAccessValueState(rawValue);
      const state = normalizeStaffAccessState(stateValue);
      if (!state) {
        errors.push(moduleAccessValidationError(field, 'INVALID_ACCESS_STATE', { key: rawKey, canonicalKey, value: stateValue }));
        continue;
      }
      if (canonicalKey === 'safeZone' && state !== 'disabled') {
        errors.push(moduleAccessValidationError(field, 'FOUNDER_ONLY_MODULE', { key: rawKey, canonicalKey, value: state }));
        continue;
      }
      states[canonicalKey] = state;
    }
  } else {
    errors.push(moduleAccessValidationError('moduleAccess', 'INVALID_MODULE_ACCESS_SHAPE', { valueType: typeof source }));
  }

  const enabledLegacyKeys = Object.entries(states)
    .filter(([, state]) => state === 'enabled')
    .map(([key]) => CANONICAL_TO_LEGACY_MODULE[key] || key);
  return { provided: true, states, enabledLegacyKeys, errors };
}

function staffModuleStateFromLegacyList(user) {
  const out = {};
  const list = Array.isArray(user?.moduleAccessOverride) ? user.moduleAccessOverride : [];
  for (const key of list) {
    const canonicalKey = canonicalModuleKey(key, { allowLegacy: true });
    if (canonicalKey) out[canonicalKey] = 'enabled';
  }
  return out;
}

function temporaryModuleGrant(user, canonicalKey, now = new Date()) {
  const list = Array.isArray(user?.temporaryAccess) ? user.temporaryAccess : [];
  let expiredMatch = null;

  for (const entry of list) {
    const moduleKey = canonicalModuleKey(entry?.moduleKey, { allowLegacy: true });
    if (moduleKey !== canonicalKey) continue;
    const expiresAt = entry?.expiresAt ? new Date(entry.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      expiredMatch = entry?.expiresAt || null;
      continue;
    }
    if (entry.enabled === false) return { state: 'disabled', expiresAt: expiresAt.toISOString(), expired: false };
    return { state: 'temporary', expiresAt: expiresAt.toISOString(), expired: false };
  }

  return expiredMatch ? { state: 'temporary', expiresAt: expiredMatch, expired: true } : null;
}

function evaluateModuleAccess(user, moduleKey, policy, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const canonicalKey = canonicalModuleKey(moduleKey, { allowLegacy: true });
  const policies = normalizeModulePolicies(policy?.modulePolicies || policy);

  if (!canonicalKey) {
    return {
      key: String(moduleKey || '').trim(),
      canonicalKey: null,
      visible: false,
      allowed: false,
      reasonCode: 'STAFF_ACCESS_DISABLED',
      globalState: null,
      individualState: 'disabled',
      temporaryExpiresAt: null,
    };
  }

  if (isFounderAccount(user)) {
    return {
      key: canonicalKey,
      canonicalKey,
      visible: true,
      allowed: true,
      reasonCode: 'ALLOWED',
      globalState: policies[canonicalKey] || 'founder_only',
      individualState: 'enabled',
      temporaryExpiresAt: null,
    };
  }

  const accountReason = accountBlockReason(user, now);
  if (accountReason) {
    return {
      key: canonicalKey,
      canonicalKey,
      visible: true,
      allowed: false,
      reasonCode: accountReason,
      globalState: policies[canonicalKey] || 'founder_only',
      individualState: 'disabled',
      temporaryExpiresAt: null,
    };
  }

  if (canonicalKey === 'dashboard') {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: true, reasonCode: 'ALLOWED', globalState: 'available', individualState: 'enabled', temporaryExpiresAt: null };
  }

  const globalState = policies[canonicalKey] || 'founder_only';
  const storedStates = normalizeStaffModuleStates(user?.moduleAccessStates);
  const legacyStates = staffModuleStateFromLegacyList(user);
  const individualState = storedStates[canonicalKey] || legacyStates[canonicalKey] || 'disabled';
  const tempGrant = temporaryModuleGrant(user, canonicalKey, now);
  const effectiveIndividualState = tempGrant?.state || individualState;
  const temporaryExpiresAt = tempGrant?.expiresAt || null;

  if (globalState === 'founder_only' || canonicalKey === 'safeZone') {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: false, reasonCode: 'FOUNDER_ONLY', globalState: 'founder_only', individualState: effectiveIndividualState, temporaryExpiresAt };
  }
  if (globalState === 'hidden') {
    return { key: canonicalKey, canonicalKey, visible: false, allowed: false, reasonCode: 'MODULE_HIDDEN', globalState, individualState: effectiveIndividualState, temporaryExpiresAt };
  }
  if (globalState === 'staff_locked') {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: false, reasonCode: 'GLOBAL_STAFF_LOCK', globalState, individualState: effectiveIndividualState, temporaryExpiresAt };
  }
  if (effectiveIndividualState === 'enabled') {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: true, reasonCode: 'ALLOWED', globalState, individualState: effectiveIndividualState, temporaryExpiresAt };
  }
  if (tempGrant?.state === 'temporary' && !tempGrant.expired) {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: true, reasonCode: 'ALLOWED', globalState, individualState: 'temporary', temporaryExpiresAt };
  }
  if (tempGrant?.expired) {
    return { key: canonicalKey, canonicalKey, visible: true, allowed: false, reasonCode: 'TEMPORARY_ACCESS_EXPIRED', globalState, individualState: 'temporary', temporaryExpiresAt };
  }

  return { key: canonicalKey, canonicalKey, visible: true, allowed: false, reasonCode: 'STAFF_ACCESS_DISABLED', globalState, individualState: effectiveIndividualState, temporaryExpiresAt };
}

function evaluateAllModuleAccess(user, policy, options = {}) {
  return CANONICAL_STAFF_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = evaluateModuleAccess(user, key, policy, options);
    return acc;
  }, {});
}

module.exports = {
  ACCESS_REASON_CODES,
  BULK_FOUNDER_ONLY_ACTION,
  BULK_FOUNDER_ONLY_CONFIRMATION,
  CANONICAL_ADMIN_MODULE_KEYS,
  CANONICAL_STAFF_MODULE_KEYS,
  CANONICAL_TO_LEGACY_MODULE,
  FIXED_ADMIN_CONTROL_KEYS,
  LEGACY_MODULE_TO_CANONICAL,
  MODULE_POLICY_STATES,
  STAFF_ACCESS_STATES,
  canonicalModuleKey,
  defaultModulePolicies,
  evaluateAllModuleAccess,
  evaluateModuleAccess,
  getFounderModulePolicy,
  modulePolicyEnvelope,
  modulePoliciesFromLegacyVisibility,
  normalizeModulePolicies,
  normalizeStaffModuleStates,
  parseStaffModuleAccessPayload,
  patchFromLegacyVisibility,
  previewFounderModulePolicy,
  updateFounderModulePolicy,
  validatePolicyPatch,
  visibilityFromPolicy,
};