const PushRegistration = require('../models/PushRegistration');
const PushDeliveryLog = require('../models/PushDeliveryLog');
const { getFirebaseAdminStatus } = require('../lib/firebaseAdmin');
const pushMessagingService = require('../services/pushMessagingService');
const mongoose = require('mongoose');

const PREFERENCE_KEYS = PushRegistration.PREFERENCE_KEYS;
const DEFAULT_PUSH_PREFERENCES = PushRegistration.DEFAULT_PUSH_PREFERENCES;
const LANGUAGES = new Set(['en', 'hi', 'gu']);
const PLATFORMS = new Set(['web', 'android', 'ios']);
const PUSH_HISTORY_TYPES = new Set(['all', 'breaking', 'article']);
const PUSH_HISTORY_STATUSES = new Set(['all', 'sent', 'failed', 'no_recipients']);
const PUSH_RECEIPT_EVENTS = new Set(['received', 'clicked']);
const REGISTRATION_BODY_KEYS = new Set([
  'registrationId',
  'registrationType',
  'type',
  'token',
  'fcmToken',
  'registrationToken',
  'fid',
  'firebaseInstallationId',
  'platform',
  'language',
  'preferences',
  'categories',
]);
const PREFERENCE_BODY_KEYS = new Set([...REGISTRATION_BODY_KEYS, 'enabled']);
const SEND_BODY_KEYS = new Set([
  'title',
  'body',
  'url',
  'language',
  'confirmSend',
  'articleId',
  'slug',
  'category',
]);
const CATEGORY_ALIASES = new Map([
  ['tech', 'technology'],
  ['science-technology', 'technology'],
  ['science-and-technology', 'technology'],
  ['sci-tech', 'technology'],
]);
const CATEGORIES = new Set([
  'national',
  'international',
  'business',
  'technology',
  'science',
  'sports',
  'entertainment',
  'regional',
  'gujarat',
  'breaking',
  'lifestyle',
  'glamour',
  'editorial',
  'youth-pulse',
  'inspiration-hub',
  'web-stories',
]);

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, success: false, status, code, message });
}

function ok(res, body = {}) {
  return res.status(200).json({ ok: true, success: true, ...body });
}

function trim(value) {
  return String(value || '').trim();
}

function maskRegistrationId(value) {
  const raw = trim(value);
  if (!raw) return '';
  if (raw.length <= 12) return `${raw.slice(0, 3)}...${raw.slice(-3)}`;
  return `${raw.slice(0, 6)}...${raw.slice(-6)}`;
}

function redactSensitiveText(value, body = {}) {
  let text = trim(value);
  if (!text) return text;

  const idInfo = resolveRegistrationId(body);
  if (idInfo.id) text = text.split(idInfo.id).join(maskRegistrationId(idInfo.id));

  text = text.replace(/[A-Za-z0-9_-]{8,}:[A-Za-z0-9._:-]{20,}/g, '[redacted-registration-id]');
  text = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-private-key]');
  text = text.replace(/("private_key"\s*:\s*")[^"]+(")/gi, '$1[redacted-private-key]$2');
  return text;
}

function summarizeValidationErrors(error, body = {}) {
  if (!error || error.name !== 'ValidationError' || !error.errors) return undefined;
  const validationErrors = {};
  for (const [path, detail] of Object.entries(error.errors)) {
    validationErrors[path] = {
      name: detail?.name,
      message: redactSensitiveText(detail?.message || '', body),
      kind: detail?.kind,
    };
  }
  return validationErrors;
}

function logPushControllerError(scope, error, body = {}) {
  const details = {
    name: error?.name,
    message: redactSensitiveText(error?.message || String(error), body),
    code: error?.code,
  };
  const validationErrors = summarizeValidationErrors(error, body);
  if (validationErrors) details.validationErrors = validationErrors;
  console.error(`[push][${scope}] failed`, details);
}

function normalizeRegistrationType(value) {
  const raw = trim(value).toLowerCase();
  if (!raw) return null;
  if (raw === 'fid' || raw === 'firebase_installation_id' || raw === 'installation') return 'fid';
  if (raw === 'token' || raw === 'fcm_token' || raw === 'registration_token') return 'token';
  return null;
}

function looksLikeFid(value) {
  const raw = trim(value);
  return /^[A-Za-z0-9_-]{16,40}$/.test(raw) && !raw.includes(':');
}

function looksLikeToken(value) {
  const raw = trim(value);
  return raw.length > 40 || raw.includes(':');
}

function resolveRegistrationId(body = {}) {
  const entries = [
    ['token', body.token],
    ['fcmToken', body.fcmToken],
    ['registrationToken', body.registrationToken],
    ['registrationId', body.registrationId],
    ['fid', body.fid],
    ['firebaseInstallationId', body.firebaseInstallationId],
  ];
  for (const [field, value] of entries) {
    const id = trim(value);
    if (id) return { field, id };
  }
  return { field: null, id: '' };
}

function inferRegistrationType(body, idInfo) {
  if (idInfo.field === 'token' || idInfo.field === 'fcmToken' || idInfo.field === 'registrationToken') return 'token';
  if (idInfo.field === 'fid' || idInfo.field === 'firebaseInstallationId') return 'fid';
  const explicit = normalizeRegistrationType(body.registrationType || body.type);
  if (explicit) return explicit;
  if (body.registrationType || body.type) return null;
  if (looksLikeFid(idInfo.id)) return 'fid';
  if (looksLikeToken(idInfo.id)) return 'token';
  return 'token';
}

function validateRegistrationId(registrationId, registrationType) {
  if (!registrationId) return 'registrationId is required';
  if (registrationId.length < 8 || registrationId.length > 4096) return 'registrationId is invalid';
  if (/\s/.test(registrationId) || /[<>]/.test(registrationId)) return 'registrationId is invalid';
  if (registrationType === 'fid' && registrationId.length > 128) return 'registrationId is invalid for fid';
  return null;
}

function normalizePlatform(value) {
  const raw = trim(value).toLowerCase();
  if (!raw || raw === 'browser' || raw === 'chrome' || raw === 'firefox' || raw === 'edge' || raw === 'safari') return 'web';
  return PLATFORMS.has(raw) ? raw : null;
}

function normalizeLanguage(value, { allowAbsent = true } = {}) {
  const raw = trim(value).toLowerCase();
  if (!raw) return allowAbsent ? undefined : null;
  const primary = raw.split(/[-_]/)[0];
  return LANGUAGES.has(primary) ? primary : null;
}

function parseBoolean(value) {
  if (value === true || value === false) return { ok: true, value };
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(raw)) return { ok: true, value: true };
    if (['false', '0', 'no', 'off'].includes(raw)) return { ok: true, value: false };
  }
  return { ok: false };
}

function parsePreferences(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'preferences must be an object' };

  const out = {};
  for (const key of Object.keys(value)) {
    if (!PREFERENCE_KEYS.includes(key)) return { ok: false, error: `Unsupported preference: ${key}` };
    const parsed = parseBoolean(value[key]);
    if (!parsed.ok) return { ok: false, error: `Invalid preference: ${key}` };
    out[key] = parsed.value;
  }
  return { ok: true, value: out };
}

function normalizeCategory(value) {
  const raw = trim(value).toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  if (!raw) return null;
  const mapped = CATEGORY_ALIASES.get(raw) || raw;
  return CATEGORIES.has(mapped) ? mapped : null;
}

function parseCategories(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, error: 'categories must be an array' };
  if (value.length > 30) return { ok: false, error: 'categories has too many values' };
  const out = [];
  for (const item of value) {
    const normalized = normalizeCategory(item);
    if (!normalized) return { ok: false, error: 'Invalid category' };
    if (!out.includes(normalized)) out.push(normalized);
  }
  return { ok: true, value: out };
}

function unsupportedBodyKey(body, allowedKeys) {
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return key;
  }
  return null;
}

function buildRegistrationInput(body = {}, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  if (Object.keys(body).length > 20) return { ok: false, error: 'Invalid request body' };
  const unsupported = unsupportedBodyKey(body, options.allowedKeys || REGISTRATION_BODY_KEYS);
  if (unsupported) return { ok: false, error: `Unsupported field: ${unsupported}` };

  const idInfo = resolveRegistrationId(body);
  const registrationType = inferRegistrationType(body, idInfo);
  if (!registrationType) return { ok: false, error: 'registrationType must be fid or token' };

  const idError = validateRegistrationId(idInfo.id, registrationType);
  if (idError) return { ok: false, error: idError };

  const platform = normalizePlatform(body.platform);
  if (!platform) return { ok: false, error: 'platform is invalid' };

  const language = normalizeLanguage(body.language);
  if (language === null) return { ok: false, error: 'language must be en, hi, or gu' };

  const preferences = parsePreferences(body.preferences);
  if (!preferences.ok) return { ok: false, error: preferences.error };

  const categories = parseCategories(body.categories);
  if (!categories.ok) return { ok: false, error: categories.error };

  return {
    ok: true,
    value: {
      registrationId: idInfo.id,
      registrationType,
      platform,
      language,
      preferences: preferences.value,
      categories: categories.value,
    },
  };
}

function buildPreferenceInput(body = {}) {
  const base = buildRegistrationInput(body, { allowedKeys: PREFERENCE_BODY_KEYS });
  if (!base.ok) return base;

  const set = {};
  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    const parsed = parseBoolean(body.enabled);
    if (!parsed.ok) return { ok: false, error: 'enabled is invalid' };
    set.enabled = parsed.value;
    set.status = parsed.value ? 'active' : 'inactive';
    set.disabledAt = parsed.value ? null : new Date();
  }
  if (base.value.language !== undefined) set.language = base.value.language;
  if (base.value.categories !== undefined) set.categories = base.value.categories;
  if (base.value.preferences !== undefined) {
    for (const [key, value] of Object.entries(base.value.preferences)) {
      set[`preferences.${key}`] = value;
    }
  }

  return { ok: true, value: { ...base.value, set } };
}

function firebaseStatusResponse() {
  const status = getFirebaseAdminStatus();
  return {
    configured: status.configured,
    messagingAvailable: status.messagingAvailable,
    status: status.status,
  };
}

function isDeliverableRegistrationType(registrationType) {
  return registrationType === 'token';
}

function pushResponseFlags(registrationType) {
  const status = firebaseStatusResponse();
  const deliveryReady = status.configured
    && status.messagingAvailable
    && pushMessagingService.isMongoReadyForPush()
    && isDeliverableRegistrationType(registrationType);
  return {
    ...(registrationType ? { registrationType } : {}),
    fcmConfigured: status.configured,
    deliveryReady,
  };
}

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeFailureCode(value) {
  const raw = trim(value).slice(0, 120);
  if (!raw || /private|secret|key/i.test(raw)) return null;
  return /^[a-z0-9_./:-]+$/i.test(raw) ? raw : null;
}

function safeSendFailureCode(result) {
  return safeFailureCode(result?.code || result?.reason || result?.errorCode);
}

function safeFailureMessage(value) {
  const raw = redactSensitiveText(value, {}).slice(0, 240);
  if (!raw || /private key|service account|credential/i.test(raw)) return null;
  return raw;
}

function buildSentBy(admin = {}) {
  return {
    id: admin.id ? String(admin.id).slice(0, 120) : null,
    email: admin.email ? String(admin.email).trim().toLowerCase().slice(0, 254) : null,
    role: admin.role ? String(admin.role).trim().toLowerCase().slice(0, 80) : null,
  };
}

function validateSendBody(body = {}, allowedKeys = SEND_BODY_KEYS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  if (Object.keys(body).length > 20) return { ok: false, error: 'Invalid request body' };
  const unsupported = unsupportedBodyKey(body, allowedKeys);
  if (unsupported) return { ok: false, error: `Unsupported field: ${unsupported}` };
  return { ok: true };
}

function validateReceiptBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  if (Object.keys(body).length > 5) return { ok: false, error: 'Invalid request body' };
  const deliveryLogId = trim(body.deliveryLogId);
  if (!/^[a-f0-9]{24}$/i.test(deliveryLogId)) return { ok: false, error: 'deliveryLogId is invalid' };
  const event = trim(body.event).toLowerCase();
  if (!PUSH_RECEIPT_EVENTS.has(event)) return { ok: false, error: 'event must be received or clicked' };
  return { ok: true, value: { deliveryLogId, event } };
}

function normalizeSendText(value, fallback, maxLength) {
  const text = trim(value || fallback).slice(0, maxLength);
  return text || trim(fallback).slice(0, maxLength);
}

function requireConfirmSend(body) {
  return body && body.confirmSend === true;
}

function normalizeSendUrl(value, options = {}) {
  return pushMessagingService.normalizePushUrl(value, options);
}

function buildDeliveryResponse(summary, extra = {}) {
  return {
    sent: summary.successCount > 0,
    type: summary.type,
    targetedCount: summary.targetedCount,
    successCount: summary.successCount,
    failureCount: summary.failureCount,
    lastFailureCode: summary.lastFailureCode || null,
    lastFailureMessage: summary.lastFailureMessage || null,
    deliveryLogCreated: !!summary.deliveryLogCreated,
    ...extra,
  };
}

function safeCountValue(value) {
  const count = Math.floor(Number(value) || 0);
  return count > 0 ? count : 0;
}

function buildSafeDeliveryMetadata(summary = {}) {
  const metadata = {};
  if (summary.metadata?.targeting) {
    metadata.targeting = {
      enabledDevices: safeCountValue(summary.metadata.targeting.enabledDevices),
      newArticleAlertEligibleDevices: safeCountValue(summary.metadata.targeting.newArticleAlertEligibleDevices),
      excludedDisabledCount: safeCountValue(summary.metadata.targeting.excludedDisabledCount),
      excludedPreferenceOffCount: safeCountValue(summary.metadata.targeting.excludedPreferenceOffCount),
      targetedCount: safeCountValue(summary.metadata.targeting.targetedCount),
    };
  }
  if (Array.isArray(summary.metadata?.firebaseFailures) && summary.metadata.firebaseFailures.length > 0) {
    metadata.firebaseFailures = summary.metadata.firebaseFailures.map((item) => ({
      code: safeFailureCode(item?.code),
      message: safeFailureMessage(item?.message),
      count: safeCountValue(item?.count),
    })).filter((item) => item.code || item.message || item.count > 0);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function createPushDeliveryLog(summary, admin) {
  try {
    if (!PushDeliveryLog || typeof PushDeliveryLog.create !== 'function') return null;
    if (summary.type !== 'breaking' && summary.type !== 'article') return null;
    return await PushDeliveryLog.create({
      type: summary.type,
      title: summary.title,
      body: summary.body,
      url: summary.url,
      articleId: summary.articleId || null,
      articleSlug: summary.articleSlug || null,
      category: summary.category || null,
      language: summary.language || null,
      targetedCount: summary.targetedCount,
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      sentAt: summary.sentAt,
      completedAt: summary.completedAt || null,
      sentBy: buildSentBy(admin),
      metadata: buildSafeDeliveryMetadata(summary),
      lastFailureCode: summary.lastFailureCode || null,
      lastFailureMessage: summary.lastFailureMessage || null,
    });
  } catch (error) {
    logPushControllerError('delivery-log', error);
    return null;
  }
}

async function updatePushDeliveryLog(summary = {}) {
  try {
    if (!summary.deliveryLogId || !PushDeliveryLog || typeof PushDeliveryLog.updateOne !== 'function') return false;
    const set = {
      targetedCount: summary.targetedCount,
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      completedAt: summary.completedAt || null,
      lastFailureCode: summary.lastFailureCode || null,
      lastFailureMessage: summary.lastFailureMessage || null,
    };
    const metadata = buildSafeDeliveryMetadata(summary);
    if (metadata !== undefined) set.metadata = metadata;
    await PushDeliveryLog.updateOne(
      { _id: summary.deliveryLogId },
      { $set: set },
    );
    return true;
  } catch (error) {
    logPushControllerError('delivery-log-update', error);
    return false;
  }
}

async function latestEnabledTokenRegistration() {
  let query = PushRegistration.findOne({ enabled: true, status: 'active', registrationType: 'token', registrationId: { $ne: null } });
  if (query && typeof query.sort === 'function') query = query.sort({ lastRegisteredAt: -1, updatedAt: -1 });
  if (query && typeof query.select === 'function') query = query.select('+registrationId registrationType enabled status lastRegisteredAt updatedAt');
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

async function findTargetRegistrations(filter) {
  let query = PushRegistration.find(filter);
  if (query && typeof query.sort === 'function') query = query.sort({ lastRegisteredAt: -1, updatedAt: -1 });
  if (query && typeof query.select === 'function') query = query.select('+registrationId registrationType enabled status lastRegisteredAt updatedAt preferences language categories');
  if (query && typeof query.lean === 'function') return query.lean();
  const rows = await query;
  return Array.isArray(rows) ? rows : [];
}

async function safePushCount(filter) {
  try {
    if (!PushRegistration || typeof PushRegistration.countDocuments !== 'function') return 0;
    return Number(await PushRegistration.countDocuments(filter)) || 0;
  } catch (error) {
    logPushControllerError('send-target-count', error);
    return 0;
  }
}

async function buildArticleTargetingDebugCounts() {
  const enabledFilter = { enabled: true, status: 'active', registrationType: 'token', registrationId: { $ne: null } };
  const eligibleFilter = { ...enabledFilter, 'preferences.newArticleAlerts': true };
  const disabledFilter = { registrationType: 'token', $or: [{ enabled: false }, { status: 'inactive' }] };
  return {
    enabledDevices: await safePushCount(enabledFilter),
    newArticleAlertEligibleDevices: await safePushCount(eligibleFilter),
    excludedDisabledCount: await safePushCount(disabledFilter),
    excludedPreferenceOffCount: await safePushCount({ ...enabledFilter, 'preferences.newArticleAlerts': { $ne: true } }),
  };
}

function addFailureSummary(summary, code, message) {
  const safeCode = safeFailureCode(code) || 'push/send_failed';
  const safeMessage = safeFailureMessage(message) || 'Push send failed';
  if (!summary.metadata) summary.metadata = {};
  if (!Array.isArray(summary.metadata.firebaseFailures)) summary.metadata.firebaseFailures = [];
  const existing = summary.metadata.firebaseFailures.find((item) => item.code === safeCode && item.message === safeMessage);
  if (existing) existing.count += 1;
  else summary.metadata.firebaseFailures.push({ code: safeCode, message: safeMessage, count: 1 });
}

function logFailedPushSummary(summary = {}) {
  if (!summary.failureCount) return;
  const code = safeFailureCode(summary.lastFailureCode) || 'push/send_failed';
  console.warn(`Push send failed: code=${code}, failures=${safeCountValue(summary.failureCount)}`);
}

async function sendToRegistrations({ type, title, body, url, registrations, message, admin, metadata = {} }) {
  const sentAt = new Date();
  const summary = {
    type,
    title,
    body,
    url,
    articleId: message?.articleId || null,
    articleSlug: message?.articleSlug || null,
    category: message?.category || null,
    language: message?.language || null,
    targetedCount: Array.isArray(registrations) ? registrations.length : 0,
    successCount: 0,
    failureCount: 0,
    lastFailureCode: null,
    lastFailureMessage: null,
    sentAt,
    completedAt: null,
    deliveryLogCreated: false,
    deliveryLogId: null,
    metadata,
  };

  const deliveryLog = await createPushDeliveryLog(summary, admin);
  if (deliveryLog?._id) {
    summary.deliveryLogId = String(deliveryLog._id);
    summary.deliveryLogCreated = true;
  }

  const messageWithDeliveryLog = summary.deliveryLogId ? { ...message, type, deliveryLogId: summary.deliveryLogId } : message;

  for (const registration of registrations || []) {
    const result = await pushMessagingService.sendPushToRegistration(registration, messageWithDeliveryLog);
    if (result?.success) summary.successCount += 1;
    else {
      summary.failureCount += 1;
      const failureCode = safeSendFailureCode(result) || 'push/send_failed';
      const failureMessage = safeFailureMessage(result?.message || result?.reason || result?.code) || 'Push send failed';
      summary.lastFailureCode = failureCode || summary.lastFailureCode;
      summary.lastFailureMessage = failureMessage || summary.lastFailureMessage;
      addFailureSummary(summary, failureCode, failureMessage);
    }
  }

  logFailedPushSummary(summary);

  summary.completedAt = new Date();
  if (summary.deliveryLogId) summary.deliveryLogCreated = await updatePushDeliveryLog(summary);
  return summary;
}

function serializePushDeliveryLog(log) {
  return {
    id: log?._id ? String(log._id) : null,
    type: log?.type || null,
    title: log?.title || '',
    body: log?.body || '',
    url: log?.url || '',
    articleId: log?.articleId || null,
    articleSlug: log?.articleSlug || null,
    category: log?.category || null,
    language: log?.language || null,
    targetedCount: Number(log?.targetedCount || 0),
    successCount: Number(log?.successCount || 0),
    failureCount: Number(log?.failureCount || 0),
    browserReceivedCount: Number(log?.browserReceivedCount || 0),
    clickedCount: Number(log?.clickedCount || 0),
    firstReceivedAt: toIsoString(log?.firstReceivedAt),
    lastReceivedAt: toIsoString(log?.lastReceivedAt),
    firstClickedAt: toIsoString(log?.firstClickedAt),
    lastClickedAt: toIsoString(log?.lastClickedAt),
    sentAt: toIsoString(log?.sentAt),
    completedAt: toIsoString(log?.completedAt),
    lastFailureCode: safeFailureCode(log?.lastFailureCode),
    lastFailureMessage: safeFailureMessage(log?.lastFailureMessage),
  };
}

async function recordPushReceipt(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const parsed = validateReceiptBody(req.body);
    if (!parsed.ok) return fail(res, 400, 'INVALID_PUSH_RECEIPT', parsed.error);

    const now = new Date();
    const incrementField = parsed.value.event === 'received' ? 'browserReceivedCount' : 'clickedCount';
    const firstAtField = parsed.value.event === 'received' ? 'firstReceivedAt' : 'firstClickedAt';
    const lastAtField = parsed.value.event === 'received' ? 'lastReceivedAt' : 'lastClickedAt';

    const existing = await PushDeliveryLog.findOne({ _id: parsed.value.deliveryLogId });
    if (!existing) return fail(res, 404, 'PUSH_DELIVERY_LOG_NOT_FOUND', 'Delivery log not found');

    const update = {
      $inc: { [incrementField]: 1 },
      $set: { [lastAtField]: now },
    };
    if (!existing[firstAtField]) update.$set[firstAtField] = now;

    await PushDeliveryLog.updateOne({ _id: parsed.value.deliveryLogId }, update);
    return ok(res);
  } catch (error) {
    logPushControllerError('receipt', error, req.body);
    return fail(res, 500, 'PUSH_RECEIPT_FAILED', 'Unable to record push receipt');
  }
}

async function latestDeliveryLog(filter, sort, select, warnings, warningCode) {
  try {
    if (!PushDeliveryLog || typeof PushDeliveryLog.findOne !== 'function') return null;
    let query = PushDeliveryLog.findOne(filter);
    if (query && typeof query.sort === 'function') query = query.sort(sort);
    if (query && typeof query.select === 'function') query = query.select(select);
    if (query && typeof query.lean === 'function') return await query.lean();
    return await query;
  } catch (error) {
    warnings.push(warningCode);
    logPushControllerError('diagnostics-delivery-log', error);
    return null;
  }
}

function parsePositiveInteger(value, fallback, max) {
  const raw = Number(value);
  const parsed = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(1, Math.min(max, parsed || fallback));
}

function parsePushHistoryDateRange(value) {
  const raw = trim(value).toLowerCase();
  if (!raw || raw === 'all') return { ok: true, filter: {} };

  const now = new Date();
  if (raw === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { ok: true, filter: { sentAt: { $gte: start } } };
  }

  const daysMatch = raw.match(/^(\d{1,4})d$/);
  if (daysMatch) {
    const days = Number.parseInt(daysMatch[1], 10);
    if (days <= 0) return { ok: false };
    return { ok: true, filter: { sentAt: { $gte: new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)) } } };
  }

  const rangeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})(?:\.\.|,)(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) {
    const start = new Date(`${rangeMatch[1]}T00:00:00.000Z`);
    const end = new Date(`${rangeMatch[2]}T23:59:59.999Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return { ok: false };
    return { ok: true, filter: { sentAt: { $gte: start, $lte: end } } };
  }

  return { ok: false };
}

function buildPushHistoryFilter(query = {}) {
  const type = trim(query.type || 'all').toLowerCase() || 'all';
  if (!PUSH_HISTORY_TYPES.has(type)) return { ok: false, error: 'type must be all, breaking, or article' };

  const status = trim(query.status || 'all').toLowerCase() || 'all';
  if (!PUSH_HISTORY_STATUSES.has(status)) return { ok: false, error: 'status must be all, sent, failed, or no_recipients' };

  const dateRange = parsePushHistoryDateRange(query.dateRange);
  if (!dateRange.ok) return { ok: false, error: 'dateRange must be all, today, Nd, or YYYY-MM-DD..YYYY-MM-DD' };

  const filter = { type: type === 'all' ? { $in: ['breaking', 'article'] } : type, ...dateRange.filter };
  if (status === 'sent') filter.successCount = { $gt: 0 };
  if (status === 'failed') filter.failureCount = { $gt: 0 };
  if (status === 'no_recipients') filter.targetedCount = 0;

  return { ok: true, filter };
}

async function countDeliveryLogs(filter) {
  if (!PushDeliveryLog || typeof PushDeliveryLog.countDocuments !== 'function') return 0;
  return Number(await PushDeliveryLog.countDocuments(filter)) || 0;
}

async function findRecentDeliveryLogs(filter, { skip = 0, limit = 5 } = {}) {
  let query = PushDeliveryLog.find(filter);
  if (query && typeof query.sort === 'function') query = query.sort({ sentAt: -1, createdAt: -1 });
  if (query && typeof query.skip === 'function') query = query.skip(skip);
  if (query && typeof query.limit === 'function') query = query.limit(limit);
  if (query && typeof query.select === 'function') query = query.select('type title body url articleId articleSlug category language targetedCount successCount failureCount browserReceivedCount clickedCount firstReceivedAt lastReceivedAt firstClickedAt lastClickedAt sentAt completedAt lastFailureCode lastFailureMessage');
  if (query && typeof query.lean === 'function') return query.lean();
  const rows = await query;
  return Array.isArray(rows) ? rows : [];
}

function isPushRegistrationModelAvailable() {
  return !!(
    PushRegistration
    && typeof PushRegistration.countDocuments === 'function'
    && typeof PushRegistration.findOne === 'function'
  );
}

function isMongoConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function safeCountRegistrations(filter, warnings, warningCode) {
  try {
    return Number(await PushRegistration.countDocuments(filter)) || 0;
  } catch (error) {
    warnings.push(warningCode);
    logPushControllerError('diagnostics-count', error);
    return 0;
  }
}

async function safeLatestRegistration(filter, sort, select, warnings, warningCode) {
  try {
    let query = PushRegistration.findOne(filter);
    if (query && typeof query.sort === 'function') query = query.sort(sort);
    if (query && typeof query.select === 'function') query = query.select(select);
    if (query && typeof query.lean === 'function') return await query.lean();
    return await query;
  } catch (error) {
    warnings.push(warningCode);
    logPushControllerError('diagnostics-latest', error);
    return null;
  }
}

async function buildPushDiagnostics() {
  const firebase = firebaseStatusResponse();
  const mongoConnected = isMongoConnected();
  const modelAvailable = isPushRegistrationModelAvailable();
  const warnings = [];

  if (!firebase.configured) warnings.push('firebase_not_configured');
  else if (!firebase.messagingAvailable) warnings.push('firebase_messaging_unavailable');
  if (!mongoConnected) warnings.push('mongodb_not_connected');
  if (!modelAvailable) warnings.push('push_registration_model_unavailable');

  let totalRegistrations = 0;
  let enabledRegistrations = 0;
  let disabledRegistrations = 0;
  let enabledTokenRegistrations = 0;
  let enabledFidOnlyRegistrations = 0;
  let lastRegistration = null;
  let lastSuccessfulSend = null;
  let lastFailure = null;
  let lastSuccessfulDeliveryLog = null;
  let lastFailureDeliveryLog = null;

  if (modelAvailable && pushMessagingService.isMongoReadyForPush()) {
    totalRegistrations = await safeCountRegistrations({}, warnings, 'registration_count_unavailable');
    enabledRegistrations = await safeCountRegistrations({ enabled: true, status: 'active' }, warnings, 'enabled_registration_count_unavailable');
    disabledRegistrations = await safeCountRegistrations({ $or: [{ enabled: false }, { status: 'inactive' }] }, warnings, 'disabled_registration_count_unavailable');
    enabledTokenRegistrations = await safeCountRegistrations({ enabled: true, status: 'active', registrationType: 'token', registrationId: { $ne: null } }, warnings, 'enabled_token_registration_count_unavailable');
    enabledFidOnlyRegistrations = await safeCountRegistrations({ enabled: true, status: 'active', registrationType: 'fid' }, warnings, 'enabled_fid_registration_count_unavailable');
    lastRegistration = await safeLatestRegistration({}, { lastRegisteredAt: -1 }, 'lastRegisteredAt', warnings, 'last_registration_unavailable');
    lastSuccessfulSend = await safeLatestRegistration({ lastSuccessfulSendAt: { $ne: null } }, { lastSuccessfulSendAt: -1 }, 'lastSuccessfulSendAt', warnings, 'last_successful_send_unavailable');
    lastFailure = await safeLatestRegistration({ lastFailureAt: { $ne: null } }, { lastFailureAt: -1 }, 'lastFailureAt lastFailureCode lastFailureReason', warnings, 'last_failure_unavailable');
    if (mongoConnected) {
      lastSuccessfulDeliveryLog = await latestDeliveryLog({ successCount: { $gt: 0 }, type: { $in: ['breaking', 'article'] } }, { sentAt: -1 }, 'sentAt completedAt successCount', warnings, 'last_successful_delivery_log_unavailable');
      lastFailureDeliveryLog = await latestDeliveryLog({ failureCount: { $gt: 0 }, type: { $in: ['breaking', 'article'] } }, { sentAt: -1 }, 'sentAt completedAt failureCount lastFailureCode lastFailureMessage', warnings, 'last_failure_delivery_log_unavailable');
    }
  }

  if (totalRegistrations === 0) warnings.push('no_push_registrations');
  if (enabledRegistrations === 0) warnings.push('no_enabled_push_registrations');
  if (enabledTokenRegistrations === 0) warnings.push('no_enabled_fcm_token_registrations');

  const deliveryReady = firebase.configured
    && firebase.messagingAvailable
    && modelAvailable
    && enabledTokenRegistrations > 0;
  const registrationStats = {
    totalRegistrations,
    enabledRegistrations,
    disabledRegistrations,
    enabledFcmTokenRegistrations: enabledTokenRegistrations,
    enabledFidOnlyRegistrations,
    total: totalRegistrations,
    enabled: enabledRegistrations,
    disabled: disabledRegistrations,
    lastRegistrationAt: toIsoString(lastRegistration?.lastRegisteredAt),
    lastSuccessfulSendAt: toIsoString(lastSuccessfulDeliveryLog?.sentAt || lastSuccessfulSend?.lastSuccessfulSendAt),
    lastFailureAt: toIsoString(lastFailureDeliveryLog?.sentAt || lastFailure?.lastFailureAt),
    lastFailureCode: safeFailureCode(lastFailureDeliveryLog?.lastFailureCode || lastFailure?.lastFailureCode),
    lastFailureMessage: safeFailureMessage(lastFailureDeliveryLog?.lastFailureMessage || lastFailure?.lastFailureReason),
  };

  return {
    firebaseConfigured: firebase.configured,
    messagingAvailable: firebase.messagingAvailable,
    firebaseStatus: firebase.status,
    mongoConnected,
    pushRegistrationModelAvailable: modelAvailable,
    totalRegistrations,
    enabledRegistrations,
    disabledRegistrations,
    enabledFcmTokenRegistrations: enabledTokenRegistrations,
    enabledFidOnlyRegistrations,
    lastRegistrationAt: registrationStats.lastRegistrationAt,
    lastSuccessfulSendAt: registrationStats.lastSuccessfulSendAt,
    lastFailureAt: registrationStats.lastFailureAt,
    lastFailureCode: registrationStats.lastFailureCode,
    lastFailureMessage: registrationStats.lastFailureMessage,
    registrationStats,
    registrations: {
      total: totalRegistrations,
      enabled: enabledRegistrations,
      disabled: disabledRegistrations,
      enabledFcmTokenRegistrations: enabledTokenRegistrations,
      enabledFidOnlyRegistrations,
    },
    mongo: {
      connected: mongoConnected,
      pushRegistrationModelAvailable: modelAvailable,
      registrations: {
        total: totalRegistrations,
        enabled: enabledRegistrations,
        disabled: disabledRegistrations,
        enabledFcmTokenRegistrations: enabledTokenRegistrations,
        enabledFidOnlyRegistrations,
      },
      lastRegistrationAt: registrationStats.lastRegistrationAt,
      lastSuccessfulSendAt: registrationStats.lastSuccessfulSendAt,
      lastFailureAt: registrationStats.lastFailureAt,
      lastFailureCode: registrationStats.lastFailureCode,
      lastFailureMessage: registrationStats.lastFailureMessage,
    },
    supportedRegistrationTypes: ['fid', 'token'],
    deliveryReady,
    notes: warnings,
    warnings,
  };
}

function ensureStorageAvailable(res) {
  if (pushMessagingService.isMongoReadyForPush()) return true;
  fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
  return false;
}

async function registerPush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const parsed = buildRegistrationInput(req.body);
    if (!parsed.ok) return fail(res, 400, 'INVALID_PUSH_REGISTRATION', parsed.error);

    const now = new Date();
    const input = parsed.value;
    const update = {
      $set: {
        platform: input.platform,
        enabled: true,
        status: 'active',
        disabledAt: null,
        lastRegisteredAt: now,
        firebaseProjectId: getFirebaseAdminStatus().projectId || null,
      },
      $setOnInsert: {
        registrationId: input.registrationId,
        registrationType: input.registrationType,
        createdAt: now,
      },
    };

    if (input.language !== undefined) update.$set.language = input.language;
    else update.$setOnInsert.language = 'en';

    if (input.categories !== undefined) update.$set.categories = input.categories;
    else update.$setOnInsert.categories = [];

    if (input.preferences !== undefined) {
      for (const [key, value] of Object.entries(input.preferences)) {
        update.$set[`preferences.${key}`] = value;
      }
    }
    for (const key of PREFERENCE_KEYS) {
      if (!input.preferences || !Object.prototype.hasOwnProperty.call(input.preferences, key)) {
        update.$setOnInsert[`preferences.${key}`] = DEFAULT_PUSH_PREFERENCES[key];
      }
    }

    await PushRegistration.findOneAndUpdate(
      { registrationId: input.registrationId, registrationType: input.registrationType },
      update,
      { upsert: true, new: true },
    );

    const flags = pushResponseFlags(input.registrationType);
    if (!isDeliverableRegistrationType(input.registrationType)) {
      return ok(res, { registered: false, synced: true, reason: 'missing_fcm_token', ...flags, deliveryReady: false, fcm: firebaseStatusResponse() });
    }

    return ok(res, { registered: true, synced: true, ...flags, fcm: firebaseStatusResponse() });
  } catch (error) {
    logPushControllerError('register', error, req.body);
    return fail(res, 500, 'PUSH_REGISTER_FAILED', 'Unable to register push notifications');
  }
}

async function updatePushPreferences(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const parsed = buildPreferenceInput(req.body);
    if (!parsed.ok) return fail(res, 400, 'INVALID_PUSH_PREFERENCES', parsed.error);
    if (Object.keys(parsed.value.set).length === 0) return fail(res, 400, 'INVALID_PUSH_PREFERENCES', 'No preferences to update');

    const result = await PushRegistration.findOneAndUpdate(
      { registrationId: parsed.value.registrationId, registrationType: parsed.value.registrationType },
      { $set: parsed.value.set },
      { new: true },
    );
    if (!result) return fail(res, 404, 'PUSH_REGISTRATION_NOT_FOUND', 'Registration not found');
    return ok(res, { updated: true, preferencesSaved: true, synced: true, ...pushResponseFlags(parsed.value.registrationType) });
  } catch (error) {
    logPushControllerError('preferences', error, req.body);
    return fail(res, 500, 'PUSH_PREFERENCES_FAILED', 'Unable to update push preferences');
  }
}

async function unregisterPush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const parsed = buildRegistrationInput(req.body);
    if (!parsed.ok) return fail(res, 400, 'INVALID_PUSH_REGISTRATION', parsed.error);

    const result = await PushRegistration.deleteOne({
      registrationId: parsed.value.registrationId,
      registrationType: parsed.value.registrationType,
    });
    return ok(res, { unregistered: (result?.deletedCount || 0) > 0, synced: true, ...pushResponseFlags(parsed.value.registrationType) });
  } catch (error) {
    logPushControllerError('unregister', error, req.body);
    return fail(res, 500, 'PUSH_UNREGISTER_FAILED', 'Unable to unregister push notifications');
  }
}

async function getPushFirebaseStatus(_req, res) {
  try {
    const diagnostics = await buildPushDiagnostics();
    return ok(res, { firebase: firebaseStatusResponse(), diagnostics, ...diagnostics });
  } catch (error) {
    logPushControllerError('status', error);
    return ok(res, { firebase: firebaseStatusResponse(), diagnosticsError: true });
  }
}

async function getPushDiagnostics(_req, res) {
  try {
    return ok(res, await buildPushDiagnostics());
  } catch (error) {
    logPushControllerError('diagnostics', error);
    return ok(res, {
      firebaseConfigured: false,
      messagingAvailable: false,
      firebaseStatus: 'error',
      mongoConnected: isMongoConnected(),
      pushRegistrationModelAvailable: isPushRegistrationModelAvailable(),
      totalRegistrations: 0,
      enabledRegistrations: 0,
      disabledRegistrations: 0,
      lastRegistrationAt: null,
      lastSuccessfulSendAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      supportedRegistrationTypes: ['fid', 'token'],
      deliveryReady: false,
      notes: ['push_diagnostics_unavailable'],
      warnings: ['push_diagnostics_unavailable'],
    });
  }
}

async function getPushHistory(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const limit = parsePositiveInteger(req.query?.limit, 5, 50);
    const page = parsePositiveInteger(req.query?.page, 1, 1000000);
    const parsedFilter = buildPushHistoryFilter(req.query || {});
    if (!parsedFilter.ok) return fail(res, 400, 'INVALID_PUSH_HISTORY_QUERY', parsedFilter.error);

    const total = await countDeliveryLogs(parsedFilter.filter);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const rows = await findRecentDeliveryLogs(parsedFilter.filter, { skip: (page - 1) * limit, limit });
    return ok(res, {
      items: rows.map(serializePushDeliveryLog),
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    logPushControllerError('history', error);
    return fail(res, 500, 'PUSH_HISTORY_FAILED', 'Unable to load push history');
  }
}

async function sendTestPush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const registrationId = trim(body.registrationId || body.token || body.fcmToken || body.registrationToken || '');
    const explicitType = body.registrationType || body.type;
    const normalizedType = normalizeRegistrationType(explicitType);
    if (explicitType && !normalizedType) return fail(res, 400, 'INVALID_PUSH_REGISTRATION', 'registrationType must be fid or token');
    const registrationType = registrationId ? (normalizedType || 'token') : undefined;
    if (registrationId) {
      const idError = validateRegistrationId(registrationId, registrationType);
      if (idError) return fail(res, 400, 'INVALID_PUSH_REGISTRATION', idError);
    }

    const result = await pushMessagingService.sendTestPushNotification({
      registrationId,
      registrationType,
      title: trim(body.title).slice(0, 120) || undefined,
      body: trim(body.body).slice(0, 240) || undefined,
      url: trim(body.url) || undefined,
    });

    const status = result.success ? 200 : (result.reason === 'registration_not_found' ? 404 : 503);
    return res.status(status).json({
      ok: result.success,
      success: result.success,
      sent: !!result.sent,
      ...(result.success ? {} : { reason: result.reason || 'send_failed' }),
      ...(result.messageId ? { messageId: result.messageId } : {}),
    });
  } catch (error) {
    logPushControllerError('test-send', error, req.body);
    return fail(res, 500, 'PUSH_TEST_FAILED', 'Unable to send test push');
  }
}

async function sendLatestTestPush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const registration = await latestEnabledTokenRegistration();
    const title = 'News Pulse';
    const body = 'Firebase push notifications are working.';
    const url = normalizeSendUrl('http://localhost:3000');
    if (!url) return fail(res, 400, 'INVALID_PUSH_URL', 'Push URL is not allowed');

    const summary = await sendToRegistrations({
      type: 'test',
      title,
      body,
      url,
      registrations: registration ? [registration] : [],
      message: { title, body, url, notificationType: 'test' },
      admin: req.admin,
    });

    const status = summary.targetedCount === 0 ? 404 : (summary.successCount > 0 ? 200 : 503);
    return res.status(status).json({
      ok: summary.successCount > 0,
      success: summary.successCount > 0,
      ...buildDeliveryResponse(summary, { foundEnabledRegistration: summary.targetedCount > 0 }),
      ...(summary.targetedCount === 0 ? { reason: 'registration_not_found' } : {}),
    });
  } catch (error) {
    logPushControllerError('test-latest', error, req.body);
    return fail(res, 500, 'PUSH_TEST_LATEST_FAILED', 'Unable to send latest test push');
  }
}

async function sendBreakingPush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const bodyInput = req.body && typeof req.body === 'object' ? req.body : {};
    const bodyCheck = validateSendBody(bodyInput);
    if (!bodyCheck.ok) return fail(res, 400, 'INVALID_PUSH_SEND', bodyCheck.error);
    if (!requireConfirmSend(bodyInput)) return fail(res, 400, 'CONFIRM_SEND_REQUIRED', 'confirmSend=true is required');

    const language = normalizeLanguage(bodyInput.language);
    if (language === null) return fail(res, 400, 'INVALID_PUSH_SEND', 'language must be en, hi, or gu');
    const title = normalizeSendText(bodyInput.title, 'Breaking News', 120);
    const messageBody = normalizeSendText(bodyInput.body, '', 240);
    if (!messageBody) return fail(res, 400, 'INVALID_PUSH_SEND', 'body is required');
    const url = normalizeSendUrl(bodyInput.url);
    if (!url) return fail(res, 400, 'INVALID_PUSH_URL', 'Push URL is not allowed');

    const filter = pushMessagingService.buildEligibilityFilter('breaking_news', { language });
    const registrations = await findTargetRegistrations(filter);
    const summary = await sendToRegistrations({
      type: 'breaking',
      title,
      body: messageBody,
      url,
      registrations,
      message: { title, body: messageBody, url, language, notificationType: 'breaking_news' },
      admin: req.admin,
    });

    return ok(res, buildDeliveryResponse(summary));
  } catch (error) {
    logPushControllerError('breaking-send', error, req.body);
    return fail(res, 500, 'PUSH_BREAKING_FAILED', 'Unable to send breaking push');
  }
}

async function sendArticlePush(req, res) {
  try {
    if (!ensureStorageAvailable(res)) return undefined;
    const bodyInput = req.body && typeof req.body === 'object' ? req.body : {};
    const bodyCheck = validateSendBody(bodyInput);
    if (!bodyCheck.ok) return fail(res, 400, 'INVALID_PUSH_SEND', bodyCheck.error);
    if (!requireConfirmSend(bodyInput)) return fail(res, 400, 'CONFIRM_SEND_REQUIRED', 'confirmSend=true is required');

    const language = normalizeLanguage(bodyInput.language);
    if (language === null) return fail(res, 400, 'INVALID_PUSH_SEND', 'language must be en, hi, or gu');
    const category = bodyInput.category === undefined ? undefined : normalizeCategory(bodyInput.category);
    if (bodyInput.category !== undefined && !category) return fail(res, 400, 'INVALID_PUSH_SEND', 'Invalid category');
    const title = normalizeSendText(bodyInput.title, 'News Pulse', 120);
    const messageBody = normalizeSendText(bodyInput.body, '', 240);
    if (!messageBody) return fail(res, 400, 'INVALID_PUSH_SEND', 'body is required');
    const articleSlug = trim(bodyInput.slug).slice(0, 200) || undefined;
    const articleId = trim(bodyInput.articleId).slice(0, 200) || undefined;
    const url = normalizeSendUrl(bodyInput.url, { articleSlug });
    if (!url) return fail(res, 400, 'INVALID_PUSH_URL', 'Push URL is not allowed');

    const filter = pushMessagingService.buildEligibilityFilter('article');
    const registrations = await findTargetRegistrations(filter);
    const targetingDebug = await buildArticleTargetingDebugCounts();
    targetingDebug.targetedCount = registrations.length;
    const summary = await sendToRegistrations({
      type: 'article',
      title,
      body: messageBody,
      url,
      registrations,
      message: { title, body: messageBody, url, articleId, articleSlug, category, language, notificationType: 'article' },
      admin: req.admin,
      metadata: { targeting: targetingDebug },
    });

    return ok(res, buildDeliveryResponse(summary, { targetingDebug }));
  } catch (error) {
    logPushControllerError('article-send', error, req.body);
    return fail(res, 500, 'PUSH_ARTICLE_FAILED', 'Unable to send article push');
  }
}

module.exports = {
  registerPush,
  updatePushPreferences,
  unregisterPush,
  recordPushReceipt,
  getPushFirebaseStatus,
  getPushDiagnostics,
  getPushHistory,
  sendTestPush,
  sendLatestTestPush,
  sendBreakingPush,
  sendArticlePush,
  buildRegistrationInput,
  buildPreferenceInput,
  buildPushDiagnostics,
};