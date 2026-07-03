const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

const { getPrivacyTransporter, getPrivacyEmailConfig } = require('../lib/emailService');
const { getPublicBaseUrl } = require('../lib/publicBaseUrl');
const {
  REQUEST_TYPE_VALUES,
  STATUS_VALUES,
  PENDING_EMAIL_VERIFICATION_STATUS,
  VERIFIED_STATUS,
  createPrivacyRequest,
  listPrivacyRequests,
  getPrivacyRequestById,
  verifyPrivacyRequestByTokenHash,
  updatePrivacyRequest,
  createDpdpAuditLog,
} = require('../services/privacyRequestStore');
const {
  BLOCKED_SOURCE_NAMES,
  KNOWN_SOURCE_NAMES,
  searchMatchingDataForPrivacyRequest,
  performPrivacyDataAction,
} = require('../services/dpdpDataActions');

const PUBLIC_RATE_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_RATE_MAX_BY_IP = 10;
const PUBLIC_RATE_MAX_BY_EMAIL = 5;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESEND_RATE_MAX_PER_REQUEST = 3;
const publicRateBuckets = new Map();
const ACTIONABLE_PRIVACY_REQUEST_STATUSES = new Set([VERIFIED_STATUS, 'In Review']);
const COMPLETION_STATUS_VALUES = new Set(['Completed', 'Closed']);
const RESEND_BLOCKED_STATUSES = new Set([VERIFIED_STATUS, 'Completed', 'Rejected', 'Spam/Fake', 'Closed']);

function sanitizeText(value, { maxLength = 1000, allowNewlines = false } = {}) {
  if (value === undefined || value === null) return '';
  let text = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = allowNewlines
    ? text.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n')
    : text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, maxLength).trim();
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getReqIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function isLocalDevelopment() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  return env === 'development' || env === 'local';
}

function isProductionEnvironment() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function rateLimitKey(kind, value) {
  return `${kind}:${String(value || '').trim().toLowerCase() || 'unknown'}`;
}

function isRateLimited(key, maxRequests) {
  const now = Date.now();
  const bucket = publicRateBuckets.get(key);
  if (!bucket || now - bucket.windowStart > PUBLIC_RATE_WINDOW_MS) {
    publicRateBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > maxRequests;
}

function looksLikeSpam({ fullName, email, message }) {
  const combined = `${fullName || ''} ${message || ''}`.replace(/[^a-z0-9]/gi, '');
  if (combined.length < 8) return true;
  if (/^(.)\1{7,}$/i.test(combined)) return true;

  const normalizedMessage = String(message || '').toLowerCase();
  const linkCount = (normalizedMessage.match(/https?:\/\//g) || []).length;
  if (linkCount > 3) return true;
  if (/(casino|viagra|free money|crypto pump|backlinks|seo ranking)/i.test(normalizedMessage)) return true;

  const localPart = String(email || '').split('@')[0].toLowerCase();
  if (localPart && String(fullName || '').toLowerCase() === localPart && normalizedMessage === localPart) return true;

  return false;
}

function generateRequestId(now = new Date()) {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `DPDP-${datePart}-${randomPart}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildVerificationUrl(req, token) {
  const configuredBase = getPublicBaseUrl();
  const requestBase = `${req.protocol}://${req.get('host')}`;
  const base = (configuredBase || requestBase).replace(/\/+$/, '');
  return `${base}/api/privacy/verify/${encodeURIComponent(token)}`;
}

async function sendPrivacyVerificationEmail({ to, verificationUrl }) {
  const subject = 'Verify your News Pulse privacy request';
  const text = [
    'We received a privacy request using this email address. Please verify the request using this link. If you did not submit this request, you can ignore this email.',
    '',
    verificationUrl,
  ].join('\n');

  let transport = null;
  let fromAddress = null;
  try {
    transport = getPrivacyTransporter();
    fromAddress = getPrivacyEmailConfig().fromAddress || 'no-reply@newspulse.co.in';
  } catch (_) {
    transport = null;
    fromAddress = null;
  }

  if (!transport) {
    if (isLocalDevelopment()) {
      console.log('[dpdp][privacy-request][verification-link]', verificationUrl);
    }
    return { sent: false, configured: false };
  }

  try {
    await transport.sendMail({
      from: fromAddress || 'no-reply@newspulse.co.in',
      to,
      subject,
      text,
    });
    return { sent: true, configured: true };
  } catch (error) {
    console.warn('[dpdp][privacy-request][mail] send failed', error?.message || error);
    if (isLocalDevelopment()) {
      console.log('[dpdp][privacy-request][verification-link]', verificationUrl);
    }
    return { sent: false, configured: true };
  }
}

function ensurePrivacyVerificationEmailSent(result) {
  if (result && result.sent) return true;
  if (isProductionEnvironment()) {
    throw new Error('Privacy verification email could not be sent');
  }
  return false;
}

function buildVerificationTokenUpdate(now = new Date()) {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    verificationTokenHash: hashToken(token),
    verificationTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
  };
}

function getRecentVerificationResends(request, now = new Date()) {
  const threshold = now.getTime() - RESEND_RATE_WINDOW_MS;
  return (Array.isArray(request?.verificationResendHistory) ? request.verificationResendHistory : [])
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()) && value.getTime() >= threshold)
    .map((value) => value.toISOString());
}

function parsePublicPayload(body) {
  const fullName = sanitizeText(body?.fullName, { maxLength: 160 });
  const email = sanitizeText(body?.email, { maxLength: 254 }).toLowerCase();
  const mobile = sanitizeText(body?.mobile, { maxLength: 40 }) || null;
  const requestType = sanitizeText(body?.requestType, { maxLength: 40 });
  const message = sanitizeText(body?.message, { maxLength: 3000, allowNewlines: true });
  const referenceId = sanitizeText(body?.referenceId, { maxLength: 160 }) || null;

  if (!fullName) return { ok: false, message: 'fullName is required' };
  if (!email || !isValidEmail(email)) return { ok: false, message: 'A valid email is required' };
  if (!requestType || !REQUEST_TYPE_VALUES.includes(requestType)) return { ok: false, message: 'requestType is invalid' };
  if (!message) return { ok: false, message: 'message is required' };
  if (looksLikeSpam({ fullName, email, message })) return { ok: false, message: 'Request could not be accepted' };

  return { ok: true, value: { fullName, email, mobile, requestType, message, referenceId } };
}

async function submitPrivacyRequest(req, res) {
  try {
    const parsed = parsePublicPayload(req.body || {});
    if (!parsed.ok) return res.status(400).json({ ok: false, success: false, message: parsed.message });

    const ipLimited = isRateLimited(rateLimitKey('ip', getReqIp(req)), PUBLIC_RATE_MAX_BY_IP);
    const emailLimited = isRateLimited(rateLimitKey('email', parsed.value.email), PUBLIC_RATE_MAX_BY_EMAIL);
    if (ipLimited || emailLimited) {
      return res.status(429).json({ ok: false, success: false, message: 'Too many requests. Please try again later.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const verificationTokenHash = hashToken(token);
    const verificationTokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    const requestId = generateRequestId();

    const created = await createPrivacyRequest({
      requestId,
      ...parsed.value,
      source: 'Frontend Form',
      status: PENDING_EMAIL_VERIFICATION_STATUS,
      verificationTokenHash,
      verificationTokenExpiresAt,
    });

    const verificationUrl = buildVerificationUrl(req, token);
    ensurePrivacyVerificationEmailSent(await sendPrivacyVerificationEmail({ to: parsed.value.email, verificationUrl }));

    return res.status(201).json({
      ok: true,
      success: true,
      message: 'Privacy request submitted. Please check your email to verify the request.',
      requestId: created.requestId,
    });
  } catch (error) {
    console.error('[dpdp][privacy-request][submit] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to submit privacy request' });
  }
}

async function verifyPrivacyRequest(req, res) {
  try {
    const token = String(req.params?.token || '').trim();
    if (!token || token.length > 200) return res.status(400).send('Invalid or expired verification link.');

    const result = await verifyPrivacyRequestByTokenHash(hashToken(token));
    if (!result || !result.request) return res.status(400).send('Invalid or expired verification link.');

    await createDpdpAuditLog({
      requestId: result.request.requestId,
      action: 'privacy_request_verified',
      oldStatus: result.oldStatus,
      newStatus: result.newStatus,
      adminNote: null,
      handledBy: 'email-verification',
      timestamp: new Date(),
    });

    const message = 'Your privacy request has been verified and will be reviewed by News Pulse.';
    const acceptsJson = String(req.headers.accept || '').includes('application/json');
    if (acceptsJson) return res.status(200).json({ ok: true, success: true, message });
    return res.status(200).send(message);
  } catch (error) {
    console.error('[dpdp][privacy-request][verify] failed', error?.message || error);
    return res.status(500).send('Unable to verify privacy request.');
  }
}

async function listAdminPrivacyRequests(req, res) {
  try {
    const status = sanitizeText(req.query?.status, { maxLength: 80 });
    if (status && status !== 'all' && !STATUS_VALUES.includes(status)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status filter' });
    }
    const requests = await listPrivacyRequests({ status });
    return res.status(200).json({ ok: true, success: true, requests });
  } catch (error) {
    console.error('[dpdp][privacy-request][admin-list] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to load privacy requests' });
  }
}

async function getAdminPrivacyRequest(req, res) {
  try {
    const request = await getPrivacyRequestById(req.params?.id);
    if (!request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });
    return res.status(200).json({ ok: true, success: true, request });
  } catch (error) {
    console.error('[dpdp][privacy-request][admin-get] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to load privacy request' });
  }
}

async function resendAdminPrivacyRequestVerification(req, res) {
  try {
    const request = await getPrivacyRequestById(req.params?.id, { includeInternal: true });
    if (!request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    if (RESEND_BLOCKED_STATUSES.has(String(request.status || ''))) {
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Verification email is not required for this request status.',
      });
    }

    if (String(request.status || '') !== PENDING_EMAIL_VERIFICATION_STATUS) {
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Verification email cannot be resent for this request status.',
      });
    }

    const now = new Date();
    const recentResends = getRecentVerificationResends(request, now);
    if (recentResends.length >= RESEND_RATE_MAX_PER_REQUEST) {
      return res.status(429).json({
        ok: false,
        success: false,
        message: 'Verification email resend limit reached for this request. Please try again later.',
      });
    }

    const tokenUpdate = buildVerificationTokenUpdate(now);
    const handledBy = getHandledByLabel(req);
    const updated = await updatePrivacyRequest(req.params?.id, {
      verificationTokenHash: tokenUpdate.verificationTokenHash,
      verificationTokenExpiresAt: tokenUpdate.verificationTokenExpiresAt,
      verificationResendHistory: [...recentResends, now.toISOString()],
      handledBy,
    });
    if (!updated || !updated.request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    const verificationUrl = buildVerificationUrl(req, tokenUpdate.token);
    ensurePrivacyVerificationEmailSent(await sendPrivacyVerificationEmail({ to: request.email, verificationUrl }));

    await createDpdpAuditLog({
      requestId: updated.request.requestId,
      action: 'resend_verification',
      oldStatus: request.status || null,
      newStatus: updated.request.status || request.status || null,
      adminNote: null,
      handledBy,
      timestamp: now,
    });

    return res.status(200).json({ success: true, message: 'Verification email resent.' });
  } catch (error) {
    console.error('[dpdp][privacy-request][resend-verification] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to resend verification email' });
  }
}

function parseAdminPatch(body) {
  const updates = {};
  const hasStatus = Object.prototype.hasOwnProperty.call(body || {}, 'status');
  const hasAdminNote = Object.prototype.hasOwnProperty.call(body || {}, 'adminNote');

  if (hasStatus) {
    const status = sanitizeText(body.status, { maxLength: 80 });
    if (!STATUS_VALUES.includes(status)) return { ok: false, message: 'Invalid status' };
    updates.status = status;
  }
  if (hasAdminNote) updates.adminNote = sanitizeText(body.adminNote, { maxLength: 3000, allowNewlines: true }) || null;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'handledBy')) {
    updates.handledBy = sanitizeText(body.handledBy, { maxLength: 160 }) || null;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'replySentAt')) {
    const rawReplySentAt = body.replySentAt;
    if (rawReplySentAt === null || rawReplySentAt === '') {
      updates.replySentAt = null;
    } else {
      const replySentAt = new Date(rawReplySentAt);
      if (!Number.isFinite(replySentAt.getTime())) return { ok: false, message: 'Invalid replySentAt' };
      updates.replySentAt = replySentAt;
    }
  }

  const allowedKeys = new Set(['status', 'adminNote', 'handledBy', 'replySentAt']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { ok: false, message: `Field not allowed: ${key}` };
  }

  if (Object.keys(updates).length === 0) return { ok: false, message: 'No allowed fields provided' };
  return { ok: true, updates, auditNeeded: hasStatus || hasAdminNote };
}

function getHandledByLabel(req) {
  return sanitizeText(req.admin?.email || req.admin?.name || 'admin', { maxLength: 160 }) || 'admin';
}

function appendActionSummary(existingSummary, nextSummary) {
  const current = sanitizeText(existingSummary, { maxLength: 4000, allowNewlines: true });
  const next = sanitizeText(nextSummary, { maxLength: 4000, allowNewlines: true });
  if (!current) return next || null;
  if (!next) return current;
  return `${current} | ${next}`;
}

function ensureActionablePrivacyRequest(request) {
  if (!request) return { ok: false, statusCode: 404, message: 'Privacy request not found' };
  if (!ACTIONABLE_PRIVACY_REQUEST_STATUSES.has(String(request.status || ''))) {
    return {
      ok: false,
      statusCode: 409,
      message: 'Privacy request must be Verified or In Review before DPDP data processing',
    };
  }
  return { ok: true };
}

function parseDataActionBody(body) {
  const action = sanitizeText(body?.action, { maxLength: 40 }).toLowerCase();
  const adminNote = sanitizeText(body?.adminNote, { maxLength: 3000, allowNewlines: true });
  const founderConfirmation = sanitizeText(body?.founderConfirmation, { maxLength: 40 });
  const status = Object.prototype.hasOwnProperty.call(body || {}, 'status')
    ? sanitizeText(body?.status, { maxLength: 80 })
    : 'In Review';

  const allowedKeys = new Set(['action', 'items', 'adminNote', 'founderConfirmation', 'status']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { ok: false, message: `Field not allowed: ${key}` };
  }

  if (!['delete', 'anonymize'].includes(action)) return { ok: false, message: 'action must be delete or anonymize' };
  if (!adminNote) return { ok: false, message: 'adminNote is required' };
  if (!['In Review', 'Completed'].includes(status)) return { ok: false, message: 'status must be In Review or Completed' };

  const expectedConfirmation = action === 'delete' ? 'DELETE' : 'ANONYMIZE';
  if (founderConfirmation !== expectedConfirmation) {
    return { ok: false, message: `founderConfirmation must equal ${expectedConfirmation}` };
  }

  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return { ok: false, message: 'items must be a non-empty array' };
  }

  const items = [];
  for (const rawItem of body.items) {
    const source = sanitizeText(rawItem?.source, { maxLength: 120 });
    const recordId = sanitizeText(rawItem?.recordId, { maxLength: 200 });
    if (!source || !recordId) return { ok: false, message: 'Each item requires source and recordId' };
    if (BLOCKED_SOURCE_NAMES.includes(source)) return { ok: false, message: `Source is blocked from DPDP actions: ${source}` };
    if (!KNOWN_SOURCE_NAMES.includes(source)) return { ok: false, message: `Source is not supported: ${source}` };
    items.push({ source, recordId });
  }

  return { ok: true, value: { action, adminNote, founderConfirmation, status, items } };
}

function parseCompleteBody(body) {
  const adminNote = sanitizeText(body?.adminNote, { maxLength: 3000, allowNewlines: true });
  const replySentProvided = Object.prototype.hasOwnProperty.call(body || {}, 'replySent');
  const replySent = replySentProvided ? body.replySent : false;
  const status = Object.prototype.hasOwnProperty.call(body || {}, 'status')
    ? sanitizeText(body?.status, { maxLength: 80 })
    : 'Completed';

  const allowedKeys = new Set(['adminNote', 'replySent', 'status']);
  for (const key of Object.keys(body || {})) {
    if (!allowedKeys.has(key)) return { ok: false, message: `Field not allowed: ${key}` };
  }

  if (!adminNote) return { ok: false, message: 'adminNote is required' };
  if (replySentProvided && typeof replySent !== 'boolean') return { ok: false, message: 'replySent must be true or false' };
  if (!COMPLETION_STATUS_VALUES.has(status)) return { ok: false, message: 'status must be Completed or Closed' };

  return { ok: true, value: { adminNote, replySent: Boolean(replySent), status } };
}

async function getAdminPrivacyRequestMatchingData(req, res) {
  try {
    const request = await getPrivacyRequestById(req.params?.id);
    if (!request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    const actionable = ensureActionablePrivacyRequest(request);
    if (!actionable.ok) {
      return res.status(actionable.statusCode).json({ ok: false, success: false, message: actionable.message });
    }

    const result = await searchMatchingDataForPrivacyRequest(request);
    return res.status(200).json({ ok: true, success: true, ...result });
  } catch (error) {
    console.error('[dpdp][privacy-request][matching-data] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to search matching data' });
  }
}

async function postAdminPrivacyRequestDataAction(req, res) {
  try {
    const request = await getPrivacyRequestById(req.params?.id);
    if (!request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    const actionable = ensureActionablePrivacyRequest(request);
    if (!actionable.ok) {
      return res.status(actionable.statusCode).json({ ok: false, success: false, message: actionable.message });
    }

    const parsed = parseDataActionBody(req.body || {});
    if (!parsed.ok) return res.status(400).json({ ok: false, success: false, message: parsed.message });

    const handledBy = getHandledByLabel(req);
    const actionResult = await performPrivacyDataAction({
      request,
      action: parsed.value.action,
      items: parsed.value.items,
      handledBy,
      newStatus: parsed.value.status,
    });

    const updated = await updatePrivacyRequest(req.params?.id, {
      status: actionResult.newStatus,
      adminNote: parsed.value.adminNote,
      handledBy,
      actionTakenSummary: appendActionSummary(request.actionTakenSummary, actionResult.actionTakenSummary),
    });
    if (!updated || !updated.request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    for (const item of actionResult.results) {
      await createDpdpAuditLog({
        requestId: updated.request.requestId,
        action: `privacy_data_${parsed.value.action}`,
        source: item.source,
        recordId: item.recordId,
        oldStatus: request.status || null,
        newStatus: updated.request.status || actionResult.newStatus,
        adminNote: parsed.value.adminNote,
        handledBy,
        timestamp: new Date(),
      });
    }

    return res.status(200).json({
      ok: true,
      success: true,
      action: parsed.value.action,
      processedCount: actionResult.results.length,
      processedItems: actionResult.results,
      request: updated.request,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error('[dpdp][privacy-request][data-action] failed', error?.message || error);
    }
    return res.status(statusCode).json({ ok: false, success: false, message: error?.message || 'Unable to process privacy request data action' });
  }
}

async function completeAdminPrivacyRequest(req, res) {
  try {
    const request = await getPrivacyRequestById(req.params?.id);
    if (!request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });
    if (String(request.status || '') === PENDING_EMAIL_VERIFICATION_STATUS) {
      return res.status(409).json({ ok: false, success: false, message: 'Privacy request must be verified before completion' });
    }

    const parsed = parseCompleteBody(req.body || {});
    if (!parsed.ok) return res.status(400).json({ ok: false, success: false, message: parsed.message });

    const handledBy = getHandledByLabel(req);
    const updated = await updatePrivacyRequest(req.params?.id, {
      status: parsed.value.status,
      adminNote: parsed.value.adminNote,
      handledBy,
      replySentAt: parsed.value.replySent ? new Date() : null,
      actionTakenSummary: appendActionSummary(
        request.actionTakenSummary,
        `completion recorded; reply sent: ${parsed.value.replySent ? 'yes' : 'no'}`
      ),
    });
    if (!updated || !updated.request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    await createDpdpAuditLog({
      requestId: updated.request.requestId,
      action: 'privacy_request_completed',
      oldStatus: request.status || null,
      newStatus: updated.request.status || parsed.value.status,
      adminNote: parsed.value.adminNote,
      handledBy,
      timestamp: new Date(),
    });

    return res.status(200).json({ ok: true, success: true, request: updated.request });
  } catch (error) {
    console.error('[dpdp][privacy-request][complete] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to complete privacy request' });
  }
}

async function patchAdminPrivacyRequest(req, res) {
  try {
    const parsed = parseAdminPatch(req.body || {});
    if (!parsed.ok) return res.status(400).json({ ok: false, success: false, message: parsed.message });

    const handledBy = parsed.updates.handledBy
      || req.admin?.email
      || req.admin?.name
      || 'admin';
    if (!parsed.updates.handledBy) parsed.updates.handledBy = handledBy;

    const result = await updatePrivacyRequest(req.params?.id, parsed.updates);
    if (!result || !result.request) return res.status(404).json({ ok: false, success: false, message: 'Privacy request not found' });

    if (parsed.auditNeeded) {
      await createDpdpAuditLog({
        requestId: result.request.requestId,
        action: 'privacy_request_admin_updated',
        oldStatus: result.oldStatus,
        newStatus: result.newStatus,
        adminNote: Object.prototype.hasOwnProperty.call(parsed.updates, 'adminNote') ? parsed.updates.adminNote : result.request.adminNote,
        handledBy,
        timestamp: new Date(),
      });
    }

    return res.status(200).json({ ok: true, success: true, request: result.request });
  } catch (error) {
    console.error('[dpdp][privacy-request][admin-patch] failed', error?.message || error);
    return res.status(500).json({ ok: false, success: false, message: 'Unable to update privacy request' });
  }
}

module.exports = {
  submitPrivacyRequest,
  verifyPrivacyRequest,
  listAdminPrivacyRequests,
  getAdminPrivacyRequest,
  resendAdminPrivacyRequestVerification,
  patchAdminPrivacyRequest,
  getAdminPrivacyRequestMatchingData,
  postAdminPrivacyRequestDataAction,
  completeAdminPrivacyRequest,
};
