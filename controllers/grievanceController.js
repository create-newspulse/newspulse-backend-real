const sanitizeHtml = require('sanitize-html');

const grievanceMailer = require('../lib/grievanceMailer');

const SUCCESS_RESPONSE = { success: true, message: 'Grievance submitted successfully.' };
const FAILURE_RESPONSE = { success: false, message: 'Unable to submit grievance right now.' };
const GRIEVANCE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const GRIEVANCE_RATE_LIMIT_MAX = 5;
const griefRateBuckets = new Map();

function getReqIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
  const forwardedIp = forwarded.split(',')[0].trim();
  return forwardedIp || req?.ip || req?.socket?.remoteAddress || null;
}

function sanitizePublicText(value, { maxLength = 500, allowNewlines = false } = {}) {
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

function isAcceptedDeclaration(value) {
  if (value === true) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function isReasonablePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function isRateLimited(req) {
  const now = Date.now();
  const key = String(getReqIp(req) || 'unknown');
  const bucket = griefRateBuckets.get(key);

  if (!bucket || now - bucket.windowStart > GRIEVANCE_RATE_LIMIT_WINDOW_MS) {
    griefRateBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > GRIEVANCE_RATE_LIMIT_MAX;
}

function looksSuspiciousPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;

  let serialized = '';
  try {
    serialized = JSON.stringify(body);
  } catch (_) {
    return true;
  }

  if (!serialized || serialized.length > 10000) return true;
  if (Object.keys(body).length > 20) return true;

  const values = Object.values(body).filter((value) => value !== undefined && value !== null);
  const totalLength = values.reduce((sum, value) => sum + String(value).length, 0);
  if (totalLength > 7000) return true;

  const linkCount = (serialized.match(/https?:\/\//gi) || []).length;
  if (linkCount > 6) return true;

  return false;
}

function buildSubmission(body, req) {
  const fullName = sanitizePublicText(body.fullName, { maxLength: 120 });
  const email = sanitizePublicText(body.email, { maxLength: 254 }).toLowerCase();
  const phone = sanitizePublicText(body.phone, { maxLength: 32 });
  const address = sanitizePublicText(body.address, { maxLength: 600, allowNewlines: true });
  const contentReference = sanitizePublicText(body.contentReference, { maxLength: 600, allowNewlines: true });
  const publicationDate = sanitizePublicText(body.publicationDate, { maxLength: 80 });
  const violationPart = sanitizePublicText(body.violationPart, { maxLength: 300, allowNewlines: true });
  const violationSummary = sanitizePublicText(body.violationSummary, { maxLength: 3000, allowNewlines: true });
  const declarationAccepted = isAcceptedDeclaration(body.declarationAccepted);
  const submittedAt = new Date().toISOString();
  const requestIp = getReqIp(req);

  return {
    fullName,
    email,
    phone,
    address,
    contentReference,
    publicationDate,
    violationPart,
    violationSummary,
    declarationAccepted,
    submittedAt,
    requestIp,
  };
}

function isValidSubmission(submission) {
  if (!submission.fullName) return false;
  if (!submission.email || !isValidEmail(submission.email)) return false;
  if (!submission.phone || !isReasonablePhone(submission.phone)) return false;
  if (!submission.address) return false;
  if (!submission.contentReference) return false;
  if (!submission.publicationDate) return false;
  if (!submission.violationPart) return false;
  if (!submission.violationSummary) return false;
  if (!submission.declarationAccepted) return false;
  return true;
}

async function submitPublicGrievance(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    if (isRateLimited(req)) {
      return res.status(429).json(FAILURE_RESPONSE);
    }

    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (looksSuspiciousPayload(body)) {
      return res.status(400).json(FAILURE_RESPONSE);
    }

    const honeypot = sanitizePublicText(
      body.websiteUrl || body.websiteURL || body.website || body.url || '',
      { maxLength: 200 }
    );
    if (honeypot) {
      return res.status(400).json(FAILURE_RESPONSE);
    }

    const submission = buildSubmission(body, req);
    if (!isValidSubmission(submission)) {
      return res.status(400).json(FAILURE_RESPONSE);
    }

    await grievanceMailer.sendGrievanceMail(submission);
    return res.status(200).json(SUCCESS_RESPONSE);
  } catch (error) {
    console.error('[grievance] submit failed', grievanceMailer.serializeMailError(error));
    return res.status(503).json(FAILURE_RESPONSE);
  }
}

module.exports = {
  submitPublicGrievance,
};