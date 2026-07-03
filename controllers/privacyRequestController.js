const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

const { getTransporter } = require('../lib/emailService');
const { getPublicBaseUrl } = require('../lib/publicBaseUrl');
const {
  REQUEST_TYPE_VALUES,
  STATUS_VALUES,
  PENDING_EMAIL_VERIFICATION_STATUS,
  createPrivacyRequest,
  listPrivacyRequests,
  getPrivacyRequestById,
  verifyPrivacyRequestByTokenHash,
  updatePrivacyRequest,
  createDpdpAuditLog,
} = require('../services/privacyRequestStore');

const PUBLIC_RATE_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_RATE_MAX_BY_IP = 10;
const PUBLIC_RATE_MAX_BY_EMAIL = 5;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const publicRateBuckets = new Map();

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
  try {
    transport = getTransporter();
  } catch (_) {
    transport = null;
  }

  if (!transport) {
    if (isLocalDevelopment()) {
      console.log('[dpdp][privacy-request][verification-link]', verificationUrl);
    }
    return { sent: false, configured: false };
  }

  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@newspulse.co.in',
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
    await sendPrivacyVerificationEmail({ to: parsed.value.email, verificationUrl });

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
  patchAdminPrivacyRequest,
};
