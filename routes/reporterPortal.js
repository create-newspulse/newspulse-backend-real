const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const CommunitySubmission = require('../models/CommunitySubmission');
const OtpToken = require('../models/OtpToken');
const ReporterContact = require('../models/ReporterContact');
const ActivityLog = require('../models/ActivityLog');
const { classifyAndWrapMailerError, sendMail, getTransporter, getMailerStatus } = require('../lib/mailer');
const { sendEmail: sendEmailStub } = require('../lib/emailStub');
const { normalizeEmail } = require('../lib/normalizeEmail');
const {
  COMMUNITY_REPORTER_CATEGORIES,
  extractSubmissionAttachments,
  inferSubmissionDeskMetadata,
  normalizeCommunityReporterCategory,
} = require('../services/communitySubmissionWorkflow');
const {
  requireReporterPortalAuth,
  requireReporterPortalOpen,
  REPORTER_PORTAL_COOKIE_NAME,
  REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME,
} = require('../middleware/reporterPortalAuth');

const router = express.Router();

const REPORTER_PORTAL_OTP_PURPOSE = 'reporter_portal_login';
const REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE = 'reporter_portal_email_change';
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_CHALLENGE_LOOKBACK_LIMIT = 10;
const OTP_REQUEST_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAttempts: 8 };
const OTP_VERIFY_RATE_LIMIT = { windowMs: 10 * 60 * 1000, maxAttempts: 10 };
const otpRequestAttempts = new Map();
const otpVerifyAttempts = new Map();
const REPORTER_EMAIL_LOOKUP_FIELDS = [
  'reporterEmailNorm',
  'reporterEmail',
  'email',
  'submittedByEmail',
  'contactEmail',
  'authorEmail',
  'contact.email',
  'reporter.email',
  'reporterProfile.email',
  'contributor.email',
];

function getReporterSessionSecret() {
  return String(process.env.REPORTER_PORTAL_SESSION_SECRET || process.env.REPORTER_SESSION_SECRET || process.env.JWT_SECRET || '').trim();
}

function resolveReporterCookieDomainFromHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'newspulse.co.in' || normalized.endsWith('.newspulse.co.in')) return '.newspulse.co.in';
  return null;
}

function getConfiguredReporterCookieDomain() {
  const candidates = [
    process.env.REPORTER_PORTAL_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.SITE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = new URL(String(candidate));
      const domain = resolveReporterCookieDomainFromHost(parsed.hostname);
      if (domain) return domain;
    } catch (_) {}
  }

  return isProductionLike() ? '.newspulse.co.in' : null;
}

function getRequestHostname(req) {
  const forwardedHost = String(req?.get('x-forwarded-host') || '').trim();
  if (forwardedHost) {
    return forwardedHost.split(',')[0].trim().split(':')[0].trim().toLowerCase();
  }

  const host = String(req?.get('Host') || '').trim();
  if (host) {
    return host.split(':')[0].trim().toLowerCase();
  }

  try {
    const origin = String(req?.get('Origin') || '').trim();
    if (origin) return new URL(origin).hostname.trim().toLowerCase();
  } catch (_) {}

  return '';
}

function resolveReporterCookieDomainForRequest(req) {
  const requestDomain = resolveReporterCookieDomainFromHost(getRequestHostname(req));
  if (requestDomain) return requestDomain;

  const configuredDomain = getConfiguredReporterCookieDomain();
  if (!configuredDomain) return null;

  const normalizedConfigured = String(configuredDomain).replace(/^\./, '').toLowerCase();
  const hostname = getRequestHostname(req);
  if (!hostname) return configuredDomain;
  if (hostname === normalizedConfigured || hostname.endsWith(`.${normalizedConfigured}`)) return configuredDomain;
  return null;
}

function isLoopbackHostname(hostname) {
  return /^(localhost|127\.0\.0\.1)$/i.test(String(hostname || '').trim());
}

function buildLoopbackCanonicalUrl(req) {
  try {
    const origin = String(req.get('Origin') || '').trim();
    const host = String(req.get('Host') || '').trim();
    if (!origin || !host) return null;

    const originUrl = new URL(origin);
    const requestHost = host.split(':')[0];
    const requestPort = host.includes(':') ? host.split(':').slice(1).join(':') : '';
    const originHost = String(originUrl.hostname || '').trim();
    const protocol = String(req.get('x-forwarded-proto') || originUrl.protocol || (req.secure ? 'https:' : 'http:')).trim();

    if (!isLoopbackHostname(originHost) || !isLoopbackHostname(requestHost)) return null;
    if (originHost.toLowerCase() === requestHost.toLowerCase()) return null;

    return `${protocol}//${originHost}${requestPort ? `:${requestPort}` : ''}${req.originalUrl || req.url}`;
  } catch (_) {
    return null;
  }
}

function getReporterSessionCookieConfig() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

const reporterSessionMiddleware = session({
  name: 'reporter_portal.sid',
  secret: getReporterSessionSecret() || 'reporter-portal-dev-session-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: getReporterSessionCookieConfig(),
});

function isHttpsRequest(req) {
  return !!(req && (req.secure || String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https'));
}

function getReporterRequestOriginProtocol(req) {
  const forwardedProto = String(req?.get('x-forwarded-proto') || '').trim().toLowerCase();
  if (forwardedProto) return forwardedProto.split(',')[0].trim() || null;
  if (req?.secure) return 'https';

  for (const header of ['Origin', 'Referer']) {
    try {
      const value = String(req?.get(header) || '').trim();
      if (!value) continue;
      const url = new URL(value);
      return String(url.protocol || '').replace(/:$/, '').trim().toLowerCase() || null;
    } catch (_) {}
  }

  return null;
}

function isLocalhostRequest(req) {
  const hostname = getRequestHostname(req);
  if (isLoopbackHostname(hostname)) return true;

  for (const header of ['Origin', 'Referer']) {
    try {
      const value = String(req?.get(header) || '').trim();
      if (!value) continue;
      if (isLoopbackHostname(new URL(value).hostname)) return true;
    } catch (_) {}
  }

  return false;
}

function shouldUseSecureReporterCookies(req) {
  if (isLocalhostRequest(req)) return false;
  if (isHttpsRequest(req)) return true;
  return getReporterRequestOriginProtocol(req) === 'https';
}

function ensureReporterSessionProxyProtocol(req, secure) {
  if (!secure || !req?.headers) return;
  const current = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
  if (current) return;
  req.headers['x-forwarded-proto'] = 'https';
}

function getReporterPortalCookieOptions(req, expiresAt) {
  const maxAge = expiresAt ? Math.max(new Date(expiresAt).getTime() - Date.now(), 0) : undefined;
  const domain = resolveReporterCookieDomainForRequest(req);
  const secure = shouldUseSecureReporterCookies(req);
  return {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: '/',
    ...(domain ? { domain } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

function syncReporterSessionCookieForRequest(req) {
  if (!req?.session?.cookie) return;
  const cookie = req.session.cookie;
  const domain = resolveReporterCookieDomainForRequest(req);
  const secure = shouldUseSecureReporterCookies(req);

  ensureReporterSessionProxyProtocol(req, secure);

  cookie.httpOnly = true;
  cookie.sameSite = secure ? 'none' : 'lax';
  cookie.secure = secure;
  cookie.path = '/';
  cookie.maxAge = 24 * 60 * 60 * 1000;

  if (domain) cookie.domain = domain;
  else delete cookie.domain;
}

function describeReporterCookieOptions(options) {
  return {
    domain: options?.domain || null,
    path: options?.path || '/',
    sameSite: options?.sameSite || null,
    secure: options?.secure === true,
    httpOnly: options?.httpOnly !== false,
    maxAge: options?.maxAge ?? null,
  };
}

function setReporterPortalSessionCookie(res, req, token, expiresAt) {
  const options = getReporterPortalCookieOptions(req, expiresAt);
  res.cookie(REPORTER_PORTAL_COOKIE_NAME, token, options);
  return options;
}

function clearReporterPortalSessionCookie(res, req) {
  res.clearCookie(REPORTER_PORTAL_COOKIE_NAME, getReporterPortalCookieOptions(req));
}

function getReporterBearerToken(req) {
  const auth = String(req?.headers?.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

function getReporterPortalCookieToken(req) {
  const cookieToken = req && req.cookies ? req.cookies[REPORTER_PORTAL_COOKIE_NAME] : null;
  const token = String(cookieToken || '').trim();
  return token || null;
}

function getReporterPortalTokenDetails(req) {
  const bearerToken = getReporterBearerToken(req);
  if (bearerToken) return { token: bearerToken, authModel: 'bearer-token' };

  const cookieToken = getReporterPortalCookieToken(req);
  if (cookieToken) return { token: cookieToken, authModel: 'cookie-token' };

  return { token: null, authModel: 'none' };
}

function buildReporterLoginChallengeToken(challenge) {
  const secret = getReporterSessionSecret();
  if (!secret) throw new Error('Reporter session secret missing');

  return jwt.sign(
    {
      type: 'reporter_portal_login_challenge',
      challengeId: String(challenge?.challengeId || challenge?._id || ''),
      email: normalizeEmail(challenge?.email) || null,
      purpose: challenge?.purpose || REPORTER_PORTAL_OTP_PURPOSE,
    },
    secret,
    {
      expiresIn: Math.max(1, Math.ceil((new Date(challenge?.expiresAt).getTime() - Date.now()) / 1000)),
    }
  );
}

function getReporterLoginChallengeToken(req) {
  return String(req?.cookies?.[REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME] || '').trim() || null;
}

function decodeReporterLoginChallengeToken(req) {
  const token = getReporterLoginChallengeToken(req);
  const secret = getReporterSessionSecret();
  if (!token || !secret) return null;
  const payload = jwt.verify(token, secret);
  if (payload?.type !== 'reporter_portal_login_challenge') return null;
  return {
    challengeId: String(payload.challengeId || '').trim() || null,
    email: normalizeEmail(payload.email) || null,
    purpose: String(payload.purpose || REPORTER_PORTAL_OTP_PURPOSE).trim() || REPORTER_PORTAL_OTP_PURPOSE,
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
  };
}

function setReporterPortalLoginChallengeCookie(res, req, challenge) {
  const token = buildReporterLoginChallengeToken(challenge);
  const options = getReporterPortalCookieOptions(req, challenge?.expiresAt || null);
  res.cookie(REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME, token, options);
  return { token, options };
}

function clearReporterPortalLoginChallengeCookie(res, req) {
  res.clearCookie(REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME, getReporterPortalCookieOptions(req));
}

function getReporterChallengeSessionId(challenge) {
  return String(challenge?.challengeId || challenge?._id || '').trim() || null;
}

function buildReporterPendingChallenge(challenge, fallback = {}) {
  return {
    challengeId: getReporterChallengeSessionId(challenge) || String(fallback.challengeId || '').trim() || null,
    email: normalizeEmail(challenge?.email || fallback.email) || null,
    purpose: String(challenge?.purpose || fallback.purpose || REPORTER_PORTAL_OTP_PURPOSE).trim() || REPORTER_PORTAL_OTP_PURPOSE,
    expiresAt: challenge?.expiresAt || fallback.expiresAt || null,
  };
}

async function saveReporterLoginChallengeSession(req, challenge) {
  if (!req || !req.session) return;
  req.session.reporterAuthChallenge = buildReporterPendingChallenge(challenge);
  await new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function clearReporterLoginChallengeSession(req) {
  if (!req?.session) return;
  delete req.session.reporterAuthChallenge;
  await new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function buildReporterSessionState(reporter) {
  return {
    reporterId: reporter && reporter._id ? String(reporter._id) : null,
    email: normalizeEmail(reporter && (reporter.email || reporter.emailLower)) || null,
    fullName: reporter && reporter.fullName ? reporter.fullName : 'Reporter',
    reporterType: reporter && reporter.reporterType ? reporter.reporterType : 'community',
    verificationLevel: reporter && reporter.verificationLevel ? reporter.verificationLevel : 'community_default',
    portalAuthVersion: typeof reporter?.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0,
    status: reporter && reporter.status ? reporter.status : 'active',
    verified: true,
  };
}

async function saveReporterSession(req, reporter) {
  if (!req || !req.session) return;
  req.session.reporter = buildReporterSessionState(reporter);
  await new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function persistReporterLastPortalLogin(reporter, when = new Date()) {
  if (!reporter?._id) return when;
  await ReporterContact.findOneAndUpdate(
    { _id: reporter._id },
    { $set: { lastPortalLoginAt: when } }
  );
  reporter.lastPortalLoginAt = when;
  return when;
}

async function destroyReporterSession(req) {
  if (!req || !req.session) return;
  await new Promise((resolve) => {
    req.session.destroy(() => resolve());
  });
}

function redirectLoopbackReporterHost(req, res, next) {
  return next();
}

router.use(redirectLoopbackReporterHost);
router.use(reporterSessionMiddleware);
router.use((req, _res, next) => {
  syncReporterSessionCookieForRequest(req);
  return next();
});

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function shouldLogReporterContactPipeline() {
  const enabled = String(process.env.REPORTER_CONTACT_PIPELINE_LOG || '').trim() === '1';
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return enabled || (env && env !== 'production');
}

function logReporterContactPipeline(payload) {
  if (!shouldLogReporterContactPipeline()) return;
  try {
    console.log('[reporter-contact-pipeline]', payload);
  } catch (_) {}
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function maskEmail(email) {
  try {
    const [user, domain] = String(email || '').split('@');
    if (!user || !domain) return email;
    return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
  } catch (_) {
    return email;
  }
}

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown'
  ).trim();
}

function isReporterAuthCompatRequest(req) {
  const path = String(req?.originalUrl || req?.url || '');
  return req?.reporterAuthCompat === true || /\/api\/reporter-auth(?:\/|$)/i.test(path);
}

function isRenderLike() {
  return !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
}

function isProductionLike() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || isRenderLike();
}

function getReporterPortalBaseUrl() {
  return firstNonEmpty(process.env.APP_BASE_URL, process.env.SITE_URL, process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
}

function shouldExposeDevOtp() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (isProductionLike()) return false;
  return String(process.env.OTP_DEV_ECHO || '') === '1';
}

function shouldLogReporterOtp() {
  if (String(process.env.REPORTER_OTP_DEBUG || '').trim() === '1') return true;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function logReporterOtp(payload) {
  if (!shouldLogReporterOtp()) return;
  try {
    console.log('[reporter-otp]', payload);
  } catch (_) {}
}

function buildReporterOtpFailure(reason) {
  if (reason === 'session_missing') {
    return {
      statusCode: 401,
      body: {
        ok: false,
        code: 'SESSION_EXPIRED',
        message: 'Session expired. Request a new verification code.',
      },
    };
  }
  if (reason === 'replaced') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: 'OTP_REPLACED',
        message: 'This code was replaced by a newer OTP. Please use the latest code.',
      },
    };
  }
  if (reason === 'expired') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: 'OTP_EXPIRED',
        message: 'This code has expired. Please request a new OTP.',
      },
    };
  }
  if (reason === 'consumed') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        code: 'OTP_ALREADY_USED',
        message: 'This code has already been used. Please request a new OTP.',
      },
    };
  }
  return {
    statusCode: 400,
    body: {
      ok: false,
      code: 'INVALID_OTP',
      message: 'Could not verify this code.',
    },
  };
}

function buildReporterOtpChallengeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function resolveOtpChallengeStatus(challenge, now = new Date()) {
  if (!challenge || typeof challenge !== 'object') return null;
  const rawStatus = normalizeToken(challenge.status || '');
  if (['active', 'expired', 'consumed', 'replaced'].includes(rawStatus)) return rawStatus;
  if (challenge.consumedAt || challenge.used === true) return 'consumed';
  if (challenge.expiresAt && new Date(challenge.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

async function saveOtpChallengeState(challenge, status, patch = {}) {
  if (!challenge || typeof challenge !== 'object') return challenge;

  const next = {
    ...patch,
    status,
    used: status === 'consumed',
  };

  if (status !== 'consumed' && next.consumedAt === undefined) next.consumedAt = null;
  if (status !== 'expired' && next.expiredAt === undefined) next.expiredAt = null;
  if (status !== 'replaced' && next.replacedAt === undefined) next.replacedAt = null;
  if (status !== 'replaced' && next.replacedByChallengeId === undefined) next.replacedByChallengeId = null;

  Object.assign(challenge, next);

  if (typeof challenge.save === 'function') {
    await challenge.save();
  }

  return challenge;
}

async function loadRecentOtpChallenges(email, purpose, limit = OTP_CHALLENGE_LOOKBACK_LIMIT) {
  const docs = await OtpToken.find({ email, purpose }).sort({ createdAt: -1 }).limit(limit);
  return Array.isArray(docs) ? docs : [];
}

async function expireStaleOtpChallenges(challenges, now = new Date()) {
  for (const challenge of Array.isArray(challenges) ? challenges : []) {
    if (resolveOtpChallengeStatus(challenge, now) !== 'expired') continue;
    const storedStatus = normalizeToken(challenge.status || '');
    if (storedStatus === 'expired') continue;
    await saveOtpChallengeState(challenge, 'expired', {
      expiredAt: challenge.expiredAt || now,
      consumedAt: null,
    });
  }
}

function getLatestActiveOtpChallenge(challenges, now = new Date()) {
  return (Array.isArray(challenges) ? challenges : []).find((challenge) => resolveOtpChallengeStatus(challenge, now) === 'active') || null;
}

async function replaceActiveOtpChallenges(challenges, replacementChallengeId, now = new Date()) {
  for (const challenge of Array.isArray(challenges) ? challenges : []) {
    if (resolveOtpChallengeStatus(challenge, now) !== 'active') continue;
    await saveOtpChallengeState(challenge, 'replaced', {
      replacedAt: now,
      replacedByChallengeId: replacementChallengeId || null,
      consumedAt: null,
      expiredAt: null,
    });
  }
}

async function createReporterOtpChallenge(email, purpose, code, now = new Date()) {
  const challengeId = buildReporterOtpChallengeId();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const codeHash = await bcrypt.hash(code, 10);
  const challenge = await OtpToken.create({
    email,
    purpose,
    challengeId,
    codeHash,
    createdAt: now,
    expiresAt,
    status: 'active',
    used: false,
    consumedAt: null,
    expiredAt: null,
    replacedAt: null,
    replacedByChallengeId: null,
  });

  return challenge;
}

async function findMatchingOtpChallenge(challenges, otp) {
  for (const challenge of Array.isArray(challenges) ? challenges : []) {
    if (!challenge || !challenge.codeHash) continue;
    const matches = await bcrypt.compare(otp, challenge.codeHash);
    if (matches) return challenge;
  }
  return null;
}

async function resolveReporterPendingLoginChallenge(req, email, options = {}) {
  const compatRequired = options.compatRequired === true;
  const lookupSource = String(options.lookupSource || 'pending').trim() || 'pending';
  let pending = null;

  try {
    pending = decodeReporterLoginChallengeToken(req);
  } catch (_) {
    pending = null;
  }

  if (!pending && req?.session?.reporterAuthChallenge) {
    pending = buildReporterPendingChallenge(null, req.session.reporterAuthChallenge);
  }

  logReporterOtp({
    email,
    action: `${lookupSource}.session-lookup`,
    challengeId: pending?.challengeId || null,
    hasActiveChallenge: false,
    reason: pending ? 'cookie_or_session_present' : 'missing',
  });

  if (!pending?.challengeId || !pending?.email) {
    logReporterOtp({
      email,
      action: `${lookupSource}.session-missing`,
      challengeId: null,
      hasActiveChallenge: false,
      reason: compatRequired ? 'session_missing' : 'missing',
    });
    return { ok: false, reason: compatRequired ? 'session_missing' : 'missing', pending: null };
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail && pending.email !== normalizedEmail) {
    logReporterOtp({
      email,
      action: `${lookupSource}.session-email-mismatch`,
      challengeId: pending.challengeId,
      hasActiveChallenge: false,
      reason: 'session_missing',
    });
    return { ok: false, reason: 'session_missing', pending };
  }

  const challenge = await OtpToken.findOne({
    email: pending.email,
    purpose: pending.purpose || REPORTER_PORTAL_OTP_PURPOSE,
    challengeId: pending.challengeId,
  });
  if (!challenge) {
    logReporterOtp({
      email: pending.email,
      action: `${lookupSource}.challenge-missing`,
      challengeId: pending.challengeId,
      hasActiveChallenge: false,
      reason: compatRequired ? 'session_missing' : 'missing',
    });
    return { ok: false, reason: compatRequired ? 'session_missing' : 'missing', pending };
  }

  const status = resolveOtpChallengeStatus(challenge);
  if (status !== 'active') {
    logReporterOtp({
      email: pending.email,
      action: `${lookupSource}.challenge-inactive`,
      challengeId: getReporterChallengeSessionId(challenge),
      hasActiveChallenge: false,
      reason: status,
    });
    return { ok: false, reason: status, pending, challenge };
  }

  const recentChallenges = await loadRecentOtpChallenges(pending.email, pending.purpose || REPORTER_PORTAL_OTP_PURPOSE);
  await expireStaleOtpChallenges(recentChallenges);
  const latestActiveChallenge = getLatestActiveOtpChallenge(recentChallenges);
  if (latestActiveChallenge && getReporterChallengeSessionId(latestActiveChallenge) !== String(pending.challengeId)) {
    logReporterOtp({
      email: pending.email,
      action: `${lookupSource}.challenge-replaced`,
      challengeId: pending.challengeId,
      hasActiveChallenge: true,
      reason: 'replaced',
    });
    return { ok: false, reason: 'replaced', pending, challenge, latestActiveChallenge };
  }

  const resolvedPending = buildReporterPendingChallenge(challenge, pending);
  logReporterOtp({
    email: resolvedPending.email,
    action: `${lookupSource}.challenge-active`,
    challengeId: resolvedPending.challengeId,
    hasActiveChallenge: true,
    reason: 'active',
  });

  return {
    ok: true,
    pending: resolvedPending,
    challenge,
  };
}

async function verifyReporterOtpChallenge(email, purpose, otp, options = {}) {
  const now = new Date();
  const recentChallenges = await loadRecentOtpChallenges(email, purpose);
  await expireStaleOtpChallenges(recentChallenges, now);

  const latestChallenge = recentChallenges[0] || null;
  const latestActiveChallenge = getLatestActiveOtpChallenge(recentChallenges, now);
  const requiredChallengeId = String(options?.requiredChallengeId || '').trim() || null;
  const requiredChallenge = requiredChallengeId
    ? recentChallenges.find((challenge) => String(challenge?.challengeId || challenge?._id || '') === requiredChallengeId) || null
    : null;
  logReporterOtp({
    email,
    action: 'verify.lookup',
    challengeId: requiredChallengeId || latestActiveChallenge?.challengeId || latestChallenge?.challengeId || null,
    hasActiveChallenge: !!latestActiveChallenge,
    reason: latestActiveChallenge ? 'latest_active_loaded' : (resolveOtpChallengeStatus(latestChallenge, now) || 'missing'),
  });

  if (requiredChallengeId && !requiredChallenge) {
    return {
      ok: false,
      reason: 'session_missing',
      challenge: null,
      hasActiveChallenge: !!latestActiveChallenge,
    };
  }

  if (requiredChallenge && resolveOtpChallengeStatus(requiredChallenge, now) !== 'active') {
    return {
      ok: false,
      reason: resolveOtpChallengeStatus(requiredChallenge, now) || 'invalid',
      challenge: requiredChallenge,
      hasActiveChallenge: !!latestActiveChallenge,
    };
  }

  if (requiredChallenge && latestActiveChallenge && String(latestActiveChallenge?.challengeId || latestActiveChallenge?._id || '') !== requiredChallengeId) {
    return {
      ok: false,
      reason: 'replaced',
      challenge: requiredChallenge,
      hasActiveChallenge: true,
    };
  }

  if (!latestActiveChallenge) {
    const matchedHistorical = await findMatchingOtpChallenge(recentChallenges, otp);
    const failureReason = matchedHistorical
      ? resolveOtpChallengeStatus(matchedHistorical, now)
      : resolveOtpChallengeStatus(latestChallenge, now) || 'invalid';
    return {
      ok: false,
      reason: failureReason === 'active' ? 'invalid' : failureReason,
      challenge: matchedHistorical || latestChallenge || null,
      hasActiveChallenge: false,
    };
  }

  const challengeToVerify = requiredChallenge || latestActiveChallenge;
  const latestMatches = await bcrypt.compare(otp, challengeToVerify.codeHash);
  if (latestMatches) {
    return {
      ok: true,
      challenge: challengeToVerify,
      reason: 'verified',
      hasActiveChallenge: true,
    };
  }

  const matchedHistorical = await findMatchingOtpChallenge(
    recentChallenges.filter((challenge) => String(challenge?._id || '') !== String(latestActiveChallenge?._id || '')),
    otp
  );

  if (matchedHistorical) {
    return {
      ok: false,
      reason: resolveOtpChallengeStatus(matchedHistorical, now) || 'invalid',
      challenge: matchedHistorical,
      hasActiveChallenge: true,
    };
  }

  return {
    ok: false,
    reason: 'invalid',
    challenge: latestActiveChallenge,
    hasActiveChallenge: true,
  };
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.responseCode ? { responseCode: error.responseCode } : {}),
    ...(error?.response ? { response: error.response } : {}),
    ...(error?.command ? { command: error.command } : {}),
    ...(error?.errno ? { errno: error.errno } : {}),
    ...(error?.syscall ? { syscall: error.syscall } : {}),
  };
}

function resolveReporterMailerFailure(error, mailerStatus) {
  const provider = mailerStatus?.provider || error?.provider || null;
  const classified = classifyAndWrapMailerError(error, { provider });
  return {
    provider: classified.provider || provider || 'unknown',
    backendCode: classified.backendCode || 'PROVIDER_UNAVAILABLE',
    error: classified,
  };
}

function createEmailServiceUnavailableError(error, mailerStatus) {
  const failure = resolveReporterMailerFailure(error, mailerStatus);
  const wrapped = new Error(failure.error?.message || error?.message || 'Verification email service unavailable');
  wrapped.code = failure.error?.code || error?.code || 'REPORTER_EMAIL_UNAVAILABLE';
  wrapped.backendCode = failure.backendCode;
  wrapped.provider = failure.provider;
  wrapped.providerErrorCode = failure.error?.code || error?.code || null;
  wrapped.responseCode = failure.error?.responseCode || error?.responseCode;
  wrapped.command = failure.error?.command || error?.command;
  wrapped.errno = failure.error?.errno || error?.errno;
  wrapped.syscall = failure.error?.syscall || error?.syscall;
  wrapped.safeClientCode = 'REPORTER_EMAIL_UNAVAILABLE';
  return wrapped;
}

function createAcceptedOtpRequestError(error) {
  const wrapped = new Error(error?.message || 'OTP request accepted without deliverable email');
  wrapped.code = error?.code || 'OTP_REQUEST_ACCEPTED';
  wrapped.responseCode = error?.responseCode;
  wrapped.response = error?.response;
  wrapped.command = error?.command;
  wrapped.errno = error?.errno;
  wrapped.syscall = error?.syscall;
  wrapped.safeClientCode = 'OTP_REQUEST_ACCEPTED';
  return wrapped;
}

function isRecipientDeliveryIssue(error) {
  const responseCode = Number(error?.responseCode);
  const command = String(error?.command || '').toUpperCase();
  const code = String(error?.code || '').toUpperCase();

  if (['EMAIL_RECIPIENT_REJECTED', 'EENVELOPE'].includes(code)) return true;
  if (command.includes('RCPT')) return true;
  if ([550, 551, 552, 553, 554].includes(responseCode)) return true;
  return false;
}

function buildOtpAcceptedResponse(email, extra = {}) {
  return {
    ok: true,
    message: 'If a reporter account exists for this email, an OTP has been sent.',
    ...(email ? { emailMasked: maskEmail(email) } : {}),
    ...extra,
  };
}

function hasReporterVerifiedSession(req) {
  return !!req?.session?.reporter;
}

function hasReporterChallengeSession(req) {
  return !!req?.session?.reporterAuthChallenge;
}

function hasAnyReporterSession(req) {
  return hasReporterVerifiedSession(req) || hasReporterChallengeSession(req);
}

function buildOtpLogContext(req, email, extra = {}) {
  return {
    path: req.originalUrl || req.url,
    method: req.method,
    ip: getClientIp(req),
    ...(email ? { emailMasked: maskEmail(email) } : {}),
    ...(email ? { normalizedEmail: email } : {}),
    ...(req.get('Origin') ? { origin: req.get('Origin') } : {}),
    ...(req.get('Referer') ? { referer: req.get('Referer') } : {}),
    productionLike: isProductionLike(),
    renderLike: isRenderLike(),
    baseUrlConfigured: !!getReporterPortalBaseUrl(),
    authModel: extra.authModel || req?.reporterPortalAuthModel || 'none',
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : hasAnyReporterSession(req),
    challengeSessionPresent: extra.challengeSessionPresent !== undefined ? extra.challengeSessionPresent : hasReporterChallengeSession(req),
    verified: extra.verified !== undefined ? extra.verified : false,
    hasJwtSecret: !!String(process.env.JWT_SECRET || '').trim(),
    jwtExpiresIn: getReporterJwtExpiresIn(),
    ...extra,
  };
}

function logReporterAuth(stage, payload) {
  console.log(`[reporter-auth][${stage}]`, payload);
}

function logReporterAuthError(stage, payload) {
  console.error(`[reporter-auth][${stage}]`, payload);
}

function logReporterSubmissions(stage, payload) {
  console.log(`[reporter-submissions][${stage}]`, payload);
}

function logReporterSubmissionsError(stage, payload) {
  console.error(`[reporter-submissions][${stage}]`, payload);
}

function logReporterDashboard(stage, payload) {
  console.log(`[reporter-dashboard][${stage}]`, payload);
}

function logReporterDashboardError(stage, payload) {
  console.error(`[reporter-dashboard][${stage}]`, payload);
}

function getReporterCollectionsQueried() {
  return ['CommunitySubmission'];
}

function buildReporterDataLogContext(req, extra = {}) {
  const totalRecordsFound = Number(extra.totalRecordsFound || 0);
  return {
    normalizedEmail: normalizeEmail(req?.reporterPortal?.email),
    authModel: extra.authModel || req?.reporterPortalAuthModel || (hasReporterVerifiedSession(req) ? 'session' : (req?.reporterPortalTokenPayload ? 'token' : 'none')),
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : hasAnyReporterSession(req),
    challengeSessionPresent: extra.challengeSessionPresent !== undefined ? extra.challengeSessionPresent : hasReporterChallengeSession(req),
    sessionExists: hasAnyReporterSession(req),
    verified: extra.verified !== undefined ? extra.verified : !!req?.reporterPortal,
    collectionsQueried: extra.collectionsQueried || getReporterCollectionsQueried(),
    totalRecordsFound,
    reasonForZero: extra.reasonForZero || (totalRecordsFound === 0 ? 'no-records-found' : null),
    ...extra,
  };
}

function buildReporterSubmissionLogContext(req, extra = {}) {
  return {
    route: '/api/reporter-portal/submissions',
    normalizedEmail: normalizeEmail(req?.reporterPortal?.email),
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : hasAnyReporterSession(req),
    challengeSessionPresent: extra.challengeSessionPresent !== undefined ? extra.challengeSessionPresent : hasReporterChallengeSession(req),
    sessionExists: hasAnyReporterSession(req),
    verified: extra.verified !== undefined ? extra.verified : !!req?.reporterPortal,
    reporterProfileFound: !!req?._reporterPortalDoc,
    resultCount: 0,
    authModel: req?.reporterPortalAuthModel || (hasReporterVerifiedSession(req) ? 'session' : (req?.reporterPortalTokenPayload ? 'token' : 'none')),
    collectionsQueried: extra.collectionsQueried || getReporterCollectionsQueried(),
    totalRecordsFound: extra.totalRecordsFound || 0,
    reasonForZero: extra.reasonForZero || null,
    ...extra,
  };
}

function getReporterMailerReadiness() {
  const mailerStatus = getMailerStatus();
  let transporterReady = mailerStatus.stubMode === true;
  let transporterError = null;
  let backendCode = mailerStatus.configured ? null : 'MAILER_NOT_CONFIGURED';

  if (mailerStatus.stubMode && isProductionLike()) {
    transporterReady = false;
    transporterError = 'EMAIL_MODE=stub is not allowed in production-like environments';
    backendCode = 'MAILER_NOT_CONFIGURED';
  } else if (!mailerStatus.stubMode && mailerStatus.configured) {
    try {
      transporterReady = !!getTransporter();
      if (!transporterReady) {
        transporterError = 'Reporter mail transporter returned null';
        backendCode = 'PROVIDER_UNAVAILABLE';
      }
    } catch (error) {
      const failure = resolveReporterMailerFailure(error, mailerStatus);
      transporterReady = false;
      transporterError = failure.error?.message || error?.message || String(error);
      backendCode = failure.backendCode;
    }
  } else if (!mailerStatus.configured) {
    transporterError = mailerStatus.missing.length
      ? `Missing mailer env: ${mailerStatus.missing.join(', ')}`
      : 'Reporter mailer is not configured';
    backendCode = 'MAILER_NOT_CONFIGURED';
  }

  return {
    ...mailerStatus,
    transporterReady,
    transporterError,
    backendCode,
  };
}

function getRateLimitKey(req, subject) {
  return `${getClientIp(req)}|${String(subject || '').trim().toLowerCase()}`;
}

function consumeRateLimit(store, key, options) {
  const now = Date.now();
  const current = Array.isArray(store.get(key)) ? store.get(key) : [];
  const fresh = current.filter((ts) => now - ts < options.windowMs);
  fresh.push(now);
  store.set(key, fresh);
  return { limited: fresh.length > options.maxAttempts, remaining: Math.max(options.maxAttempts - fresh.length, 0) };
}

function clearRateLimit(store, key) {
  store.delete(key);
}

async function logReporterActivity(type, email, meta = {}) {
  try {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return;
    await ActivityLog.create({ type, email: normalizeEmail(email), meta });
  } catch (_) {}
}

function getReporterJwtExpiresIn() {
  return String(process.env.REPORTER_PORTAL_JWT_EXPIRES_IN || '24h').trim() || '24h';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReporterEmailLookupClauses(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];

  const caseInsensitive = new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i');
  const clauses = [];
  for (const field of REPORTER_EMAIL_LOOKUP_FIELDS) {
    clauses.push({ [field]: normalizedEmail });
    if (field !== 'reporterEmailNorm') {
      clauses.push({ [field]: caseInsensitive });
    }
  }
  return clauses;
}

function getTokenExpiresAt(token) {
  try {
    const payload = jwt.decode(token);
    if (payload && payload.exp) return new Date(payload.exp * 1000);
  } catch (_) {}
  return null;
}

function mapReporterProfile(reporter) {
  return {
    id: reporter && reporter._id ? String(reporter._id) : null,
    email: normalizeEmail(reporter && (reporter.email || reporter.emailLower)),
    fullName: reporter && reporter.fullName ? reporter.fullName : 'Reporter',
    reporterType: reporter && reporter.reporterType ? reporter.reporterType : 'community',
    verificationLevel: reporter && reporter.verificationLevel ? reporter.verificationLevel : 'community_default',
    portalAccessEnabled: reporter ? reporter.portalAccessEnabled !== false : true,
    status: reporter && reporter.status ? reporter.status : 'active',
    phone: reporter && reporter.phoneFull ? reporter.phoneFull : null,
    country: reporter && reporter.country ? reporter.country : null,
    stateName: reporter && reporter.stateName ? reporter.stateName : null,
    districtName: reporter && reporter.districtName ? reporter.districtName : null,
    cityTownVillage: reporter && reporter.cityTownVillage ? reporter.cityTownVillage : null,
    pendingPortalEmail: reporter && reporter.pendingPortalEmail ? reporter.pendingPortalEmail : null,
    lastPortalLoginAt: reporter && reporter.lastPortalLoginAt ? reporter.lastPortalLoginAt : null,
  };
}

function mapVerificationLevelForSubmission(contact) {
  const verificationLevel = String(contact && contact.verificationLevel || '').toLowerCase();
  if (verificationLevel === 'verified') return 'journalist_verified';
  if (verificationLevel === 'pending') return 'journalist_pending';
  return 'unverified';
}

function toPortalStatus(rawStatus) {
  const value = normalizeToken(rawStatus);
  if (value === 'draft') return 'DRAFT';
  if (value === 'submitted') return 'SUBMITTED';
  if (value === 'needs-revision' || value === 'revision-requested') return 'NEEDS_REVISION';
  if (value === 'approved') return 'APPROVED';
  if (value === 'published' || value === 'publish') return 'PUBLISHED';
  if (['rejected', 'trash', 'discarded', 'deleted', 'withdrawn', 'archived'].includes(value)) return 'REJECTED';
  return 'UNDER_REVIEW';
}

function isPublishedSubmission(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (toPortalStatus(doc.status) === 'PUBLISHED') return true;
  return !!(doc.linkedArticleId || doc.articleId || doc.publishedAt);
}

function getSubmissionPortalStatus(doc) {
  if (isPublishedSubmission(doc)) return 'PUBLISHED';
  return toPortalStatus(doc && doc.status);
}

function toStoredStatusForCreate(action) {
  return normalizeToken(action) === 'draft' ? 'DRAFT' : 'SUBMITTED';
}

function toStoredStatusForUpdate(currentPortalStatus, action) {
  const normalizedAction = normalizeToken(action);
  if (currentPortalStatus === 'DRAFT') {
    return normalizedAction === 'submit' || normalizedAction === 'submitted' ? 'SUBMITTED' : 'DRAFT';
  }
  if (currentPortalStatus === 'NEEDS_REVISION') {
    return normalizedAction === 'submit' || normalizedAction === 'submitted' ? 'SUBMITTED' : 'NEEDS_REVISION';
  }
  return null;
}

function canEditSubmission(doc) {
  const portalStatus = getSubmissionPortalStatus(doc);
  return portalStatus === 'DRAFT' || portalStatus === 'NEEDS_REVISION';
}

function matchesPortalStatus(doc, requestedStatus) {
  const requested = normalizeToken(requestedStatus);
  if (!requested || requested === 'all') return true;
  const portalStatus = getSubmissionPortalStatus(doc);
  if (requested === 'pending') {
    return ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_REVISION'].includes(portalStatus);
  }
  return portalStatus === requested.toUpperCase().replace(/-/g, '_');
}

function buildReporterOwnershipFilter(reporter) {
  const email = normalizeEmail(reporter && reporter.email);
  const clauses = [];
  if (reporter && reporter.reporterId && mongoose.isValidObjectId(String(reporter.reporterId))) {
    clauses.push({ reporterId: reporter.reporterId });
  }
  clauses.push(...buildReporterEmailLookupClauses(email));

  return {
    isDeleted: { $ne: true },
    ...(clauses.length ? { $or: clauses } : { _id: null }),
  };
}

function applySubmissionPatch(doc, payload = {}, reporter) {
  const headline = typeof payload.headline === 'string' ? payload.headline.trim() : undefined;
  const story = typeof payload.story === 'string'
    ? payload.story.trim()
    : (typeof payload.body === 'string' ? payload.body.trim() : undefined);
  const category = payload && Object.prototype.hasOwnProperty.call(payload, 'category')
    ? normalizeCommunityReporterCategory(payload.category)
    : undefined;
  const phone = typeof payload.phone === 'string'
    ? payload.phone.trim()
    : (typeof payload.contactPhone === 'string' ? payload.contactPhone.trim() : undefined);
  const whatsapp = typeof payload.whatsapp === 'string'
    ? payload.whatsapp.trim()
    : (typeof payload.whatsappNumber === 'string' ? payload.whatsappNumber.trim() : undefined);
  const location = payload.location;
  const locationText = typeof location === 'string' ? location.trim() : '';
  const locationParts = locationText ? locationText.split(',').map((part) => part.trim()).filter(Boolean) : [];
  const locationObj = location && typeof location === 'object' ? location : null;
  const city = typeof payload.city === 'string'
    ? payload.city.trim()
    : (locationObj && typeof locationObj.city === 'string' ? locationObj.city.trim() : (locationParts[0] || ''));
  const district = typeof payload.district === 'string'
    ? payload.district.trim()
    : (locationObj && typeof locationObj.district === 'string' ? locationObj.district.trim() : '');
  const state = typeof payload.state === 'string'
    ? payload.state.trim()
    : (locationObj && typeof locationObj.state === 'string' ? locationObj.state.trim() : (locationParts[1] || ''));
  const country = typeof payload.country === 'string'
    ? payload.country.trim()
    : (locationObj && typeof locationObj.country === 'string' ? locationObj.country.trim() : (locationParts[2] || ''));
  const area = typeof payload.area === 'string'
    ? payload.area.trim()
    : (locationObj && typeof locationObj.area === 'string' ? locationObj.area.trim() : '');
  const areaType = typeof payload.areaType === 'string' ? payload.areaType.trim() : '';
  const coverageScope = typeof payload.coverageScope === 'string' ? payload.coverageScope.trim() : '';
  const beat = typeof payload.beat === 'string'
    ? payload.beat.trim()
    : (typeof payload.primaryBeat === 'string' ? payload.primaryBeat.trim() : '');
  const organisationName = typeof payload.organisationName === 'string'
    ? payload.organisationName.trim()
    : (typeof payload.organizationName === 'string'
      ? payload.organizationName.trim()
      : (typeof payload.organization === 'string' ? payload.organization.trim() : ''));
  const organisationType = typeof payload.organisationType === 'string'
    ? payload.organisationType.trim()
    : (typeof payload.organizationType === 'string' ? payload.organizationType.trim() : '');
  const reporterName = reporter && (reporter.fullName || reporter.name) ? String(reporter.fullName || reporter.name).trim() : '';
  const reporterEmail = reporter && reporter.email ? String(reporter.email).trim().toLowerCase() : '';
  const portalAccessEnabled = typeof reporter?.portalAccessEnabled === 'boolean'
    ? reporter.portalAccessEnabled
    : undefined;
  const portalAuthVersion = typeof reporter?.portalAuthVersion === 'number'
    ? reporter.portalAuthVersion
    : undefined;

  if (headline !== undefined) doc.headline = headline;
  if (story !== undefined) doc.body = story;
  if (category !== undefined) doc.category = category || null;
  if (locationText || locationObj || city || district || state || country || area) {
    doc.location = {
      city: city || null,
      state: state || null,
      country: country || null,
    };
    doc.locationDetail = {
      city: city || null,
      district: district || null,
      state: state || null,
      country: country || null,
    };
    doc.city = city || undefined;
    doc.district = district || undefined;
    doc.state = state || undefined;
    doc.country = country || undefined;
    doc.area = area || undefined;
    doc.reporterLocation = locationText || city || undefined;
  }
  if (areaType) doc.areaType = areaType;
  if (coverageScope) doc.coverageScope = coverageScope;
  if (beat) doc.beat = beat;
  if (organisationName) doc.organisationName = organisationName;
  if (organisationType) doc.organisationType = organisationType;
  if (phone !== undefined) {
    doc.phone = phone || undefined;
    doc.phoneNumber = phone || undefined;
    doc.contactNumber = phone || undefined;
  }
  if (whatsapp !== undefined) {
    doc.whatsapp = whatsapp || undefined;
    doc.whatsappNumber = whatsapp || undefined;
  }
  if (portalAccessEnabled !== undefined) {
    doc.portalAccessEnabled = portalAccessEnabled;
    doc.portalAuthStatus = portalAccessEnabled ? 'authenticated' : 'disabled';
  }
  if (portalAuthVersion !== undefined) doc.portalAuthVersion = portalAuthVersion;

  doc.contact = doc.contact && typeof doc.contact === 'object' ? doc.contact : {};
  doc.contact.name = reporterName || doc.contact.name || doc.reporterName || doc.name;
  doc.contact.email = reporterEmail || doc.contact.email || doc.reporterEmail || doc.email;
  if (phone !== undefined) doc.contact.phone = phone || undefined;
  if (whatsapp !== undefined) doc.contact.whatsappNumber = whatsapp || undefined;

  const attachments = extractSubmissionAttachments(payload);
  if (attachments.length) {
    doc.attachments = attachments;
    doc.mediaUrl = attachments[0] && attachments[0].url ? attachments[0].url : doc.mediaUrl;
    doc.mediaLink = attachments[0] && attachments[0].url ? attachments[0].url : doc.mediaLink;
  }

  const deskMeta = inferSubmissionDeskMetadata(payload);
  if (deskMeta.desk) doc.desk = deskMeta.desk;
  if (deskMeta.submissionType) doc.submissionType = deskMeta.submissionType;
  if (deskMeta.intakeSource) doc.intakeSource = deskMeta.intakeSource;
  if (deskMeta.track) {
    doc.track = deskMeta.track;
    if (!doc.category) doc.category = deskMeta.track;
  }
}

function mapSubmission(doc) {
  const location = doc && (doc.location || doc.locationDetail) ? (doc.location || doc.locationDetail) : null;
  return {
    id: doc && doc._id ? String(doc._id) : null,
    headline: doc && doc.headline ? doc.headline : '',
    story: doc && doc.body ? doc.body : '',
    category: doc && doc.category ? doc.category : null,
    desk: doc && doc.desk ? doc.desk : null,
    track: doc && doc.track ? doc.track : null,
    portalStatus: getSubmissionPortalStatus(doc),
    rawStatus: doc && doc.status ? doc.status : null,
    canEdit: canEditSubmission(doc),
    createdAt: doc && doc.createdAt ? doc.createdAt : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
    attachments: Array.isArray(doc && doc.attachments) ? doc.attachments : [],
    location,
    contact: doc && doc.contact ? {
      name: doc.contact.name || null,
      email: doc.contact.email || null,
      phone: doc.contact.phone || null,
    } : null,
    linkedArticleId: doc && doc.linkedArticleId ? String(doc.linkedArticleId) : null,
    articleId: doc && doc.articleId ? String(doc.articleId) : null,
  };
}

function buildSummary(submissions) {
  const summary = {
    totalSubmissions: submissions.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    published: 0,
  };
  const breakdown = {
    DRAFT: 0,
    SUBMITTED: 0,
    UNDER_REVIEW: 0,
    NEEDS_REVISION: 0,
    APPROVED: 0,
    REJECTED: 0,
    PUBLISHED: 0,
  };

  submissions.forEach((submission) => {
    const portalStatus = getSubmissionPortalStatus(submission);
    breakdown[portalStatus] = (breakdown[portalStatus] || 0) + 1;
    if (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_REVISION'].includes(portalStatus)) summary.pending += 1;
    if (portalStatus === 'APPROVED') summary.approved += 1;
    if (portalStatus === 'REJECTED') summary.rejected += 1;
    if (portalStatus === 'PUBLISHED') summary.published += 1;
  });

  return { summary, breakdown };
}

async function sendReporterOtpEmail(email, code) {
  const subject = 'News Pulse Reporter Portal OTP';
  const baseUrl = getReporterPortalBaseUrl();
  const text = [
    `Your News Pulse Reporter Portal OTP is: ${code}. It is valid for 10 minutes.`,
    baseUrl ? `Requested from: ${baseUrl}` : '',
  ].filter(Boolean).join(' ');
  const mailerStatus = getReporterMailerReadiness();
  const stubMode = mailerStatus.stubMode === true;

  console.log('[reporter-portal][mail][prepare]', buildOtpLogContext({
    originalUrl: '/api/reporter-auth/request-code',
    url: '/api/reporter-auth/request-code',
    method: 'POST',
    get: () => undefined,
    headers: {},
    ip: 'internal',
    socket: null,
  }, email, {
    mode: stubMode ? 'stub' : mailerStatus.provider,
    provider: mailerStatus.provider,
    backendCode: mailerStatus.backendCode,
    envPresence: mailerStatus.resolved,
    baseUrl,
  }));

  if (stubMode) {
    if (isProductionLike()) {
      throw createEmailServiceUnavailableError({ message: 'EMAIL_MODE=stub is not allowed in production', code: 'EMAIL_STUB_FORBIDDEN' }, mailerStatus);
    }
    await sendEmailStub({ to: email, subject, text });
    console.log('[reporter-portal][mail][sent]', { emailMasked: maskEmail(email), mode: 'stub' });
    return { method: 'stub' };
  }

  let transporter = null;
  try {
    transporter = getTransporter();
    console.log('[reporter-portal][mail][transporter-initialized]', {
      emailMasked: maskEmail(email),
      provider: mailerStatus.provider,
      hasTransporter: !!transporter,
      productionLike: isProductionLike(),
      baseUrlConfigured: !!baseUrl,
      envPresence: mailerStatus.resolved,
    });
  } catch (error) {
    const failure = resolveReporterMailerFailure(error, mailerStatus);
    console.error('[reporter-portal][mail][transporter-failed]', {
      emailMasked: maskEmail(email),
      provider: failure.provider,
      backendCode: failure.backendCode,
      error: serializeError(failure.error),
    });
    throw createEmailServiceUnavailableError(failure.error, mailerStatus);
  }
  if (!transporter) {
    throw createEmailServiceUnavailableError({ message: 'Email transporter not configured', code: 'EMAIL_TRANSPORTER_MISSING' }, mailerStatus);
  }

  let info;
  try {
    info = await sendMail({ to: email, subject, text, html: `<p>${text}</p>` });
  } catch (error) {
    const failure = resolveReporterMailerFailure(error, mailerStatus);
    console.error('[reporter-portal][mail][send-failed]', {
      emailMasked: maskEmail(email),
      provider: failure.provider,
      backendCode: failure.backendCode,
      error: serializeError(failure.error),
    });
    if (isRecipientDeliveryIssue(error)) {
      throw createAcceptedOtpRequestError(error);
    }
    throw createEmailServiceUnavailableError(failure.error, mailerStatus);
  }
  const accepted = Array.isArray(info && info.accepted) ? info.accepted.map((value) => String(value || '').toLowerCase()) : [];
  if (!accepted.includes(email)) {
    const error = new Error('SMTP did not accept recipient');
    error.code = 'EMAIL_RECIPIENT_REJECTED';
    console.error('[reporter-portal][mail][recipient-rejected]', {
      emailMasked: maskEmail(email),
      accepted,
    });
    throw createAcceptedOtpRequestError(error);
  }
  console.log('[reporter-portal][mail][sent]', {
    emailMasked: maskEmail(email),
    mode: mailerStatus.provider,
    provider: mailerStatus.provider,
    acceptedCount: accepted.length,
  });
  return { method: info?.provider || mailerStatus.provider || 'email' };
}

async function resolveReporterFromEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  let reporter = await ReporterContact.findOne({ $or: [{ email: normalizedEmail }, { emailLower: normalizedEmail }] });
  if (reporter) return reporter;

  const latestSubmission = await CommunitySubmission.findOne({
    isDeleted: { $ne: true },
    $or: buildReporterEmailLookupClauses(normalizedEmail),
  }).sort({ createdAt: -1 });

  if (latestSubmission) {
    const { upsertReporterContactFromSubmission } = require('../services/reporterContactService');
    const result = await upsertReporterContactFromSubmission(latestSubmission.toObject ? latestSubmission.toObject() : latestSubmission);
    reporter = result && result.contact ? result.contact : null;
    if (!reporter && result && result.contactId) {
      reporter = await ReporterContact.findById(result.contactId);
    }
  }

  if (reporter) return reporter;

  try {
    const { upsertReporterContact } = require('../services/reporterContactService');
    const result = await upsertReporterContact({
      email: normalizedEmail,
      name: 'Reporter',
      reporterType: 'community',
    });
    reporter = result && result.contact ? result.contact : null;
    if (!reporter && result && result.contactId) {
      reporter = await ReporterContact.findById(result.contactId);
    }
  } catch (error) {
    logReporterAuthError('request-code', {
      route: '/api/reporter-auth/request-code',
      normalizedEmail,
      transporterReady: false,
      errorMessage: error?.message || String(error),
    });
  }
  return reporter;
}

async function backfillReporterOwnership(reporter) {
  if (!reporter || !reporter._id) return;
  const normalizedEmail = normalizeEmail(reporter.email || reporter.emailLower);
  if (!normalizedEmail) return;

  await CommunitySubmission.updateMany(
    {
      isDeleted: { $ne: true },
      reporterId: { $exists: false },
      $or: buildReporterEmailLookupClauses(normalizedEmail),
    },
    {
      $set: {
        reporterId: reporter._id,
        reporterEmailNorm: normalizedEmail,
      },
    }
  ).catch(() => {});
}

async function updateReporterSubmissionIdentity(reporter, nextEmail, nextName) {
  if (!reporter || !reporter._id) return;
  const email = normalizeEmail(nextEmail || reporter.email || reporter.emailLower);
  const name = String(nextName || reporter.fullName || 'Reporter').trim() || 'Reporter';

  await CommunitySubmission.updateMany(
    {
      isDeleted: { $ne: true },
      reporterId: reporter._id,
    },
    {
      $set: {
        reporterEmail: email,
        reporterEmailNorm: email,
        email,
        submittedByEmail: email,
        contactEmail: email,
        reporterName: name,
        name,
        'contact.email': email,
        'contact.name': name,
      },
    }
  ).catch(() => {});
}

function buildReporterToken(reporter) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw new Error('JWT_SECRET missing');

  return jwt.sign(
    {
      sub: String(reporter._id),
      reporterId: String(reporter._id),
      email: normalizeEmail(reporter.email || reporter.emailLower),
      fullName: reporter.fullName || 'Reporter',
      reporterType: reporter.reporterType || 'community',
      verificationLevel: reporter.verificationLevel || 'community_default',
      portalAccessEnabled: reporter.portalAccessEnabled !== false,
      portalAuthVersion: typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0,
      status: reporter.status || 'active',
      type: 'reporter_portal',
    },
    secret,
    { expiresIn: getReporterJwtExpiresIn() }
  );
}

async function loadOwnedSubmissions(reporter) {
  const filter = buildReporterOwnershipFilter(reporter);
  const docs = await CommunitySubmission.find(filter).sort({ createdAt: -1 });
  return Array.isArray(docs) ? docs : [];
}

router.post('/auth/request-login-otp', requireReporterPortalOpen, async (req, res) => {
  let createdOtpRecord = null;
  let email = '';
  try {
    logReporterAuth('request-code', buildOtpLogContext(req, undefined, {
      route: '/api/reporter-auth/request-code',
      action: 'received',
    }));
    email = normalizeEmail(req.body && req.body.email);
    logReporterAuth('request-code', buildOtpLogContext(req, email, {
      route: '/api/reporter-auth/request-code',
      action: 'normalized-email',
      returnedStatusCode: null,
    }));
    if (!email) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REQUIRED', message: 'Email is required.' });
    }

    const mailerStatus = getReporterMailerReadiness();
    logReporterAuth('request-code', buildOtpLogContext(req, email, {
      route: '/api/reporter-auth/request-code',
      action: 'mailer-status',
      returnedStatusCode: null,
      provider: mailerStatus.provider,
      backendCode: mailerStatus.backendCode,
      mailerConfigured: mailerStatus.configured,
      transporterReady: mailerStatus.transporterReady,
      missing: mailerStatus.missing,
      resolved: mailerStatus.resolved,
      errorMessage: mailerStatus.transporterError,
    }));
    if (!mailerStatus.configured || !mailerStatus.transporterReady) {
      logReporterAuthError('request-code', {
        route: '/api/reporter-auth/request-code',
        normalizedEmail: email,
        returnedStatusCode: 503,
        provider: mailerStatus.provider,
        backendCode: mailerStatus.backendCode || 'MAILER_NOT_CONFIGURED',
        transporterReady: mailerStatus.transporterReady,
        missing: mailerStatus.missing,
        resolved: mailerStatus.resolved,
        errorMessage: mailerStatus.transporterError,
      });
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_EMAIL_UNAVAILABLE',
        backendCode: mailerStatus.backendCode || 'MAILER_NOT_CONFIGURED',
        message: 'Verification email service is temporarily unavailable.',
      });
    }

    const rateLimitKey = getRateLimitKey(req, email);
    const requestLimit = consumeRateLimit(otpRequestAttempts, rateLimitKey, OTP_REQUEST_RATE_LIMIT);
    if (requestLimit.limited) {
      await logReporterActivity('reporter_portal_otp_request_rate_limited', email, { ip: getClientIp(req) });
      return res.status(429).json({ ok: false, code: 'OTP_REQUEST_RATE_LIMITED', backendCode: 'COOLDOWN_ACTIVE', message: 'Too many OTP requests. Please try again later.' });
    }

    const reporter = await resolveReporterFromEmail(email);
    if (!reporter) {
      logReporterAuthError('request-code', {
        route: '/api/reporter-auth/request-code',
        normalizedEmail: email,
        transporterReady: mailerStatus.transporterReady,
        errorMessage: 'Reporter identity could not be created or resolved',
      });
      return res.status(500).json({ ok: false, code: 'OTP_REQUEST_FAILED', message: 'Failed to request login OTP.' });
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      await logReporterActivity('reporter_portal_otp_request_blocked', email, { ip: getClientIp(req), status, portalAccessEnabled: reporter.portalAccessEnabled !== false });
      return res.status(200).json(buildOtpAcceptedResponse());
    }

    const otpChallenges = await loadRecentOtpChallenges(email, REPORTER_PORTAL_OTP_PURPOSE);
    await expireStaleOtpChallenges(otpChallenges);
    const existingOtp = getLatestActiveOtpChallenge(otpChallenges);

    const code = generateOtp();
    const challengeIssuedAt = new Date();
    createdOtpRecord = await createReporterOtpChallenge(email, REPORTER_PORTAL_OTP_PURPOSE, code, challengeIssuedAt);
    await replaceActiveOtpChallenges(otpChallenges, createdOtpRecord.challengeId, challengeIssuedAt);
    await saveReporterLoginChallengeSession(req, createdOtpRecord);
    const pendingChallengeCookie = setReporterPortalLoginChallengeCookie(res, req, createdOtpRecord);
    const expiresAt = createdOtpRecord.expiresAt;
    logReporterAuth('request-code', buildOtpLogContext(req, email, {
      route: '/api/reporter-auth/request-code',
      action: 'otp-generated',
      returnedStatusCode: null,
      expiresAt: new Date(expiresAt).toISOString(),
      otpLength: code.length,
    }));
    logReporterOtp({
      email,
      action: 'request.challenge-created',
      challengeId: getReporterChallengeSessionId(createdOtpRecord),
      hasActiveChallenge: true,
      reason: existingOtp ? 'created_and_replaced_previous' : 'created',
    });
    logReporterOtp({
      email,
      action: 'request.session-created',
      challengeId: getReporterChallengeSessionId(createdOtpRecord),
      hasActiveChallenge: true,
      reason: 'cookie_set',
      cookie: describeReporterCookieOptions(pendingChallengeCookie.options),
      sessionCookie: describeReporterCookieOptions(req?.session?.cookie),
    });
    const mailResult = await sendReporterOtpEmail(email, code);
    await logReporterActivity('reporter_portal_otp_requested', email, { ip: getClientIp(req), reporterId: reporter && reporter._id ? String(reporter._id) : null });
    logReporterAuth('request-code', {
      route: '/api/reporter-auth/request-code',
      normalizedEmail: email,
      sessionPresent: hasAnyReporterSession(req),
      challengeSessionPresent: hasReporterChallengeSession(req),
      verified: false,
      returnedStatusCode: 200,
      provider: mailerStatus.provider,
      backendCode: null,
      transporterReady: mailerStatus.transporterReady,
      sendMethod: mailResult?.method || null,
      action: 'otp-sent',
    });

    return res.status(200).json({
      ...buildOtpAcceptedResponse(email),
      ...(shouldExposeDevOtp() ? { devCode: code } : {}),
    });
  } catch (error) {
    if (createdOtpRecord && resolveOtpChallengeStatus(createdOtpRecord) === 'active') {
      try {
        await saveOtpChallengeState(createdOtpRecord, 'expired', {
          expiredAt: new Date(),
          consumedAt: null,
        });
      } catch (cleanupError) {
        logReporterAuthError('request-code', {
          route: '/api/reporter-auth/request-code',
          normalizedEmail: email,
          returnedStatusCode: 500,
          transporterReady: false,
          errorMessage: cleanupError?.message || String(cleanupError),
        });
      }
    }
    logReporterAuthError('request-code', {
      route: '/api/reporter-auth/request-code',
      normalizedEmail: email,
      returnedStatusCode: error && error.safeClientCode === 'REPORTER_EMAIL_UNAVAILABLE' ? 503 : (error && error.safeClientCode === 'OTP_REQUEST_ACCEPTED' ? 200 : 500),
      provider: error?.provider || null,
      backendCode: error?.backendCode || null,
      transporterReady: false,
      errorMessage: error?.message || String(error),
      error: serializeError(error),
    });
    if (error && error.safeClientCode === 'REPORTER_EMAIL_UNAVAILABLE') {
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_EMAIL_UNAVAILABLE',
        backendCode: error.backendCode || 'PROVIDER_UNAVAILABLE',
        message: 'Verification email service is temporarily unavailable.',
      });
    }
    if (error && error.safeClientCode === 'OTP_REQUEST_ACCEPTED') {
      return res.status(200).json(buildOtpAcceptedResponse(email));
    }
    return res.status(500).json({ ok: false, code: 'OTP_REQUEST_FAILED', message: 'Failed to request login OTP.' });
  }
});

router.post('/auth/verify-login-otp', requireReporterPortalOpen, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const otp = String(req.body && (req.body.otp || req.body.code) || '').trim();
    const compatPendingRequired = isReporterAuthCompatRequest(req);
    logReporterOtp({ email, action: 'verify.received', challengeId: null, hasActiveChallenge: false, reason: null });
    logReporterAuth('verify', {
      route: '/api/reporter-auth/verify-code',
      normalizedEmail: email,
      authModel: 'mixed',
      sessionPresent: false,
      sessionExists: false,
      verified: false,
      returnedStatusCode: null,
      transporterReady: null,
      action: 'received',
    });
    if (!email || !otp) {
      return res.status(400).json({ ok: false, code: 'OTP_REQUIRED', message: 'Email and OTP are required.' });
    }

    const rateLimitKey = getRateLimitKey(req, email);
    const verifyLimit = consumeRateLimit(otpVerifyAttempts, rateLimitKey, OTP_VERIFY_RATE_LIMIT);
    if (verifyLimit.limited) {
      await logReporterActivity('reporter_portal_otp_verify_rate_limited', email, { ip: getClientIp(req) });
      return res.status(429).json({ ok: false, code: 'OTP_VERIFY_RATE_LIMITED', message: 'Too many verification attempts. Please try again later.' });
    }

    let pendingChallenge = null;
    if (compatPendingRequired) {
      const pendingResult = await resolveReporterPendingLoginChallenge(req, email, {
        compatRequired: true,
        lookupSource: 'verify',
      });
      if (!pendingResult.ok) {
        clearReporterPortalLoginChallengeCookie(res, req);
        await clearReporterLoginChallengeSession(req).catch(() => null);
        logReporterOtp({
          email,
          action: 'verify.session-missing',
          challengeId: pendingResult.pending?.challengeId || null,
          hasActiveChallenge: false,
          reason: pendingResult.reason || 'session_missing',
        });
        const failure = buildReporterOtpFailure(pendingResult.reason || 'session_missing');
        return res.status(failure.statusCode).json(failure.body);
      }
      pendingChallenge = pendingResult.pending;
    }

    const verification = await verifyReporterOtpChallenge(email, REPORTER_PORTAL_OTP_PURPOSE, otp, {
      requiredChallengeId: pendingChallenge?.challengeId || null,
    });
    if (!verification.ok) {
      await logReporterActivity('reporter_portal_otp_verify_failed', email, { ip: getClientIp(req), reason: verification.reason || 'invalid' });
      logReporterOtp({
        email,
        action: 'verify.failed',
        challengeId: verification.challenge?.challengeId || String(verification.challenge?._id || ''),
        hasActiveChallenge: verification.hasActiveChallenge === true,
        reason: verification.reason || 'invalid',
      });
      const failure = buildReporterOtpFailure(verification.reason);
      return res.status(failure.statusCode).json(failure.body);
    }

    const otpRecord = verification.challenge;

    clearRateLimit(otpVerifyAttempts, rateLimitKey);

    await saveOtpChallengeState(otpRecord, 'consumed', {
      consumedAt: new Date(),
    });
    clearReporterPortalLoginChallengeCookie(res, req);
    await clearReporterLoginChallengeSession(req).catch(() => null);
    logReporterOtp({
      email,
      action: 'verify.success',
      challengeId: otpRecord.challengeId || String(otpRecord._id || ''),
      hasActiveChallenge: true,
      reason: 'consumed',
    });

    const reporter = await resolveReporterFromEmail(email);
    if (!reporter) {
      await logReporterActivity('reporter_portal_login_failed', email, { ip: getClientIp(req), reason: 'reporter_not_found' });
      logReporterAuthError('verify-code', {
        route: '/api/reporter-auth/verify-code',
        normalizedEmail: email,
        authModel: 'mixed',
        sessionPresent: false,
        sessionExists: false,
        verified: false,
        returnedStatusCode: 403,
        transporterReady: null,
        errorMessage: 'Reporter account not found after OTP verification',
      });
      return res.status(403).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      await logReporterActivity('reporter_portal_login_blocked', email, { ip: getClientIp(req), status, portalAccessEnabled: reporter.portalAccessEnabled !== false });
      return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
    }

    const loginAt = new Date();
    await persistReporterLastPortalLogin(reporter, loginAt);

    await backfillReporterOwnership(reporter).catch((error) => {
      logReporterAuthError('verify', {
        route: '/api/reporter-auth/verify-code',
        normalizedEmail: email,
        authModel: 'mixed',
        sessionPresent: false,
        sessionExists: false,
        verified: false,
        returnedStatusCode: null,
        transporterReady: null,
        errorMessage: error?.message || String(error),
        action: 'ownership-backfill-failed',
      });
    });

    const token = buildReporterToken(reporter);
    const expiresAt = getTokenExpiresAt(token);
    const submissions = await loadOwnedSubmissions({ reporterId: reporter._id, email });
    const { summary } = buildSummary(submissions);
    await logReporterActivity('reporter_portal_login', email, { ip: getClientIp(req), reporterId: String(reporter._id), expiresAt, loginAt });
    await saveReporterSession(req, reporter).catch((error) => {
      logReporterAuthError('verify', {
        route: '/api/reporter-auth/verify-code',
        normalizedEmail: email,
        authModel: 'mixed',
        sessionPresent: false,
        sessionExists: false,
        verified: false,
        returnedStatusCode: null,
        transporterReady: null,
        errorMessage: error?.message || String(error),
        action: 'session-save-failed',
      });
    });
    const reporterSessionCookie = setReporterPortalSessionCookie(res, req, token, expiresAt);
    logReporterAuth('verify', {
      route: '/api/reporter-auth/verify-code',
      normalizedEmail: email,
      authModel: 'mixed',
      sessionPresent: true,
      sessionExists: true,
      verified: true,
      returnedStatusCode: 200,
      transporterReady: null,
      resultCount: submissions.length,
      action: 'verified',
      cookie: describeReporterCookieOptions(reporterSessionCookie),
    });

    return res.status(200).json({
      ok: true,
      token,
      expiresAt,
      reporter: {
        id: String(reporter._id),
        email,
        fullName: reporter.fullName || 'Reporter',
        reporterType: reporter.reporterType || 'community',
        verificationLevel: reporter.verificationLevel || 'community_default',
      },
      summary,
    });
  } catch (error) {
    logReporterAuthError('verify', {
      route: '/api/reporter-auth/verify-code',
      normalizedEmail: normalizeEmail(req.body && req.body.email),
      authModel: 'mixed',
      sessionPresent: !!req?.session?.reporter,
      sessionExists: false,
      verified: false,
      returnedStatusCode: 500,
      transporterReady: null,
      errorMessage: error?.message || String(error),
    });
    return res.status(500).json({ ok: false, code: 'OTP_VERIFY_FAILED', message: 'Failed to verify login OTP.' });
  }
});

router.post('/auth/logout', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const currentVersion = typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0;
    reporterDoc.portalAuthVersion = currentVersion + 1;
    await reporterDoc.save();
    await destroyReporterSession(req);
    await clearReporterLoginChallengeSession(req).catch(() => null);
    clearReporterPortalSessionCookie(res, req);
    clearReporterPortalLoginChallengeCookie(res, req);
    await logReporterActivity('reporter_portal_logout', req.reporterPortal.email, { ip: getClientIp(req), reporterId: String(reporterDoc._id) });
    return res.status(200).json({ ok: true, message: 'Logged out successfully.' });
  } catch (error) {
    console.error('[reporter-portal][logout] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'LOGOUT_FAILED', message: 'Failed to logout.' });
  }
});

router.get('/profile', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }
    return res.status(200).json({ ok: true, profile: mapReporterProfile(reporterDoc) });
  } catch (error) {
    console.error('[reporter-portal][profile] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'PROFILE_LOAD_FAILED', message: 'Failed to load profile.' });
  }
});

router.patch('/profile', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const requestedEmail = normalizeEmail(req.body && req.body.email);
    if (requestedEmail && requestedEmail !== normalizeEmail(reporterDoc.email || reporterDoc.emailLower)) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REVERIFICATION_REQUIRED', message: 'Use the verified email change flow to change your login email.' });
    }

    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : undefined;
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : undefined;
    const country = typeof req.body?.country === 'string' ? req.body.country.trim() : undefined;
    const stateName = typeof req.body?.stateName === 'string' ? req.body.stateName.trim() : undefined;
    const districtName = typeof req.body?.districtName === 'string' ? req.body.districtName.trim() : undefined;
    const cityTownVillage = typeof req.body?.cityTownVillage === 'string' ? req.body.cityTownVillage.trim() : undefined;

    if (fullName !== undefined) reporterDoc.fullName = fullName || reporterDoc.fullName;
    if (phone !== undefined) reporterDoc.phoneFull = phone || undefined;
    if (country !== undefined) reporterDoc.country = country || reporterDoc.country;
    if (stateName !== undefined) reporterDoc.stateName = stateName || undefined;
    if (districtName !== undefined) reporterDoc.districtName = districtName || undefined;
    if (cityTownVillage !== undefined) reporterDoc.cityTownVillage = cityTownVillage || undefined;

    await reporterDoc.save();
    await updateReporterSubmissionIdentity(reporterDoc, reporterDoc.email || reporterDoc.emailLower, reporterDoc.fullName);
    await logReporterActivity('reporter_portal_profile_updated', req.reporterPortal.email, { ip: getClientIp(req), reporterId: String(reporterDoc._id) });

    return res.status(200).json({ ok: true, profile: mapReporterProfile(reporterDoc) });
  } catch (error) {
    console.error('[reporter-portal][profile-update] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'PROFILE_UPDATE_FAILED', message: 'Failed to update profile.' });
  }
});

router.post('/profile/email/request-change', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const nextEmail = normalizeEmail(req.body && req.body.email);
    if (!nextEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REQUIRED', message: 'Email is required.' });
    }

    const currentEmail = normalizeEmail(reporterDoc.email || reporterDoc.emailLower);
    if (nextEmail === currentEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_UNCHANGED', message: 'New email must be different from current email.' });
    }

    const requestLimitKey = getRateLimitKey(req, `email-change:${nextEmail}`);
    const requestLimit = consumeRateLimit(otpRequestAttempts, requestLimitKey, OTP_REQUEST_RATE_LIMIT);
    if (requestLimit.limited) {
      await logReporterActivity('reporter_portal_email_change_rate_limited', currentEmail, { ip: getClientIp(req), nextEmail });
      return res.status(429).json({ ok: false, code: 'OTP_REQUEST_RATE_LIMITED', message: 'Too many OTP requests. Please try again later.' });
    }

    const existing = await ReporterContact.findOne({ $or: [{ email: nextEmail }, { emailLower: nextEmail }] });
    if (existing && String(existing._id) !== String(reporterDoc._id)) {
      return res.status(409).json({ ok: false, code: 'EMAIL_ALREADY_IN_USE', message: 'That email is already linked to another reporter account.' });
    }

    const existingEmailChangeChallenges = await loadRecentOtpChallenges(nextEmail, REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE);
    await expireStaleOtpChallenges(existingEmailChangeChallenges);
    const code = generateOtp();
    const createdChallenge = await createReporterOtpChallenge(nextEmail, REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, code);
    await replaceActiveOtpChallenges(existingEmailChangeChallenges, createdChallenge.challengeId, new Date(createdChallenge.createdAt || Date.now()));
    logReporterOtp({
      email: nextEmail,
      action: 'email-change.challenge-created',
      challengeId: createdChallenge.challengeId || String(createdChallenge._id || ''),
      hasActiveChallenge: true,
      reason: 'created',
    });

    reporterDoc.pendingPortalEmail = nextEmail;
    reporterDoc.pendingPortalEmailRequestedAt = new Date();
    await reporterDoc.save();
    await sendReporterOtpEmail(nextEmail, code);
    await logReporterActivity('reporter_portal_email_change_requested', currentEmail, { ip: getClientIp(req), nextEmail, reporterId: String(reporterDoc._id) });

    return res.status(200).json({
      ok: true,
      emailMasked: maskEmail(nextEmail),
      message: 'Verification code sent to the new email address.',
      ...((process.env.NODE_ENV === 'test' || String(process.env.OTP_DEV_ECHO || '') === '1') ? { devCode: code } : {}),
    });
  } catch (error) {
    console.error('[reporter-portal][profile-email-request] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'EMAIL_CHANGE_REQUEST_FAILED', message: 'Failed to start email change verification.' });
  }
});

router.post('/profile/email/confirm-change', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const nextEmail = normalizeEmail(req.body && req.body.email);
    const otp = String(req.body && (req.body.otp || req.body.code) || '').trim();
    if (!nextEmail || !otp) {
      return res.status(400).json({ ok: false, code: 'OTP_REQUIRED', message: 'Email and OTP are required.' });
    }

    if (normalizeEmail(reporterDoc.pendingPortalEmail) !== nextEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_CHANGE_NOT_REQUESTED', message: 'No pending email verification exists for that address.' });
    }

    const verifyLimitKey = getRateLimitKey(req, `email-change:${nextEmail}`);
    const verifyLimit = consumeRateLimit(otpVerifyAttempts, verifyLimitKey, OTP_VERIFY_RATE_LIMIT);
    if (verifyLimit.limited) {
      await logReporterActivity('reporter_portal_email_change_verify_rate_limited', req.reporterPortal.email, { ip: getClientIp(req), nextEmail });
      return res.status(429).json({ ok: false, code: 'OTP_VERIFY_RATE_LIMITED', message: 'Too many verification attempts. Please try again later.' });
    }

    const verification = await verifyReporterOtpChallenge(nextEmail, REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, otp);
    if (!verification.ok) {
      logReporterOtp({
        email: nextEmail,
        action: 'email-change.verify-failed',
        challengeId: verification.challenge?.challengeId || String(verification.challenge?._id || ''),
        hasActiveChallenge: verification.hasActiveChallenge === true,
        reason: verification.reason || 'invalid',
      });
      const failure = buildReporterOtpFailure(verification.reason);
      return res.status(failure.statusCode).json(failure.body);
    }

    const otpRecord = verification.challenge;

    clearRateLimit(otpVerifyAttempts, verifyLimitKey);

    await saveOtpChallengeState(otpRecord, 'consumed', {
      consumedAt: new Date(),
    });
    logReporterOtp({
      email: nextEmail,
      action: 'email-change.verify-success',
      challengeId: otpRecord.challengeId || String(otpRecord._id || ''),
      hasActiveChallenge: true,
      reason: 'consumed',
    });

    const previousEmail = normalizeEmail(reporterDoc.email || reporterDoc.emailLower);
    reporterDoc.email = nextEmail;
    reporterDoc.emailLower = nextEmail;
    reporterDoc.pendingPortalEmail = null;
    reporterDoc.pendingPortalEmailRequestedAt = null;
    reporterDoc.portalAuthVersion = (typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0) + 1;
    await reporterDoc.save();

    await updateReporterSubmissionIdentity(reporterDoc, nextEmail, reporterDoc.fullName);
    await logReporterActivity('reporter_portal_email_change_confirmed', previousEmail, { ip: getClientIp(req), nextEmail, reporterId: String(reporterDoc._id) });

    return res.status(200).json({
      ok: true,
      reverifyRequired: true,
      message: 'Email updated successfully. Please login again with the new email.',
      profile: mapReporterProfile(reporterDoc),
    });
  } catch (error) {
    console.error('[reporter-portal][profile-email-confirm] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'EMAIL_CHANGE_CONFIRM_FAILED', message: 'Failed to confirm email change.' });
  }
});

router.get('/auth/challenge-session', requireReporterPortalOpen, async (req, res) => {
  try {
    const requestedEmail = normalizeEmail(req.query?.email || req.body?.email || '');
    const pendingResult = await resolveReporterPendingLoginChallenge(req, requestedEmail || null, {
      compatRequired: false,
      lookupSource: 'challenge-session',
    });

    logReporterAuth('challenge-session', {
      route: '/api/reporter-auth/challenge-session',
      normalizedEmail: requestedEmail || pendingResult.pending?.email || null,
      authModel: req?.reporterPortalAuthModel || 'none',
      sessionPresent: !!req?.session?.reporter,
      sessionExists: !!req?.session,
      verified: false,
      returnedStatusCode: pendingResult.ok ? 200 : (pendingResult.reason && pendingResult.reason !== 'missing' ? buildReporterOtpFailure(pendingResult.reason).statusCode : 401),
      action: pendingResult.ok ? 'pending-found' : 'pending-missing',
      pendingChallengeId: pendingResult.pending?.challengeId || null,
      reason: pendingResult.reason || null,
    });

    if (pendingResult.ok) {
      return res.status(200).json({
        ok: true,
        authenticated: false,
        challenge: {
          challengeId: pendingResult.pending.challengeId,
          email: pendingResult.pending.email,
          emailMasked: maskEmail(pendingResult.pending.email),
          expiresAt: pendingResult.pending.expiresAt || null,
          status: 'pending',
        },
        session: {
          expiresAt: pendingResult.pending.expiresAt || null,
          status: 'pending',
        },
        portal: req.reporterPortalState || null,
      });
    }

    if (pendingResult.reason && pendingResult.reason !== 'missing') {
      clearReporterPortalLoginChallengeCookie(res, req);
      await clearReporterLoginChallengeSession(req).catch(() => null);
      const failure = buildReporterOtpFailure(pendingResult.reason || 'session_missing');
      return res.status(failure.statusCode).json(failure.body);
    }

    const failure = buildReporterOtpFailure('session_missing');
    return res.status(failure.statusCode).json(failure.body);
  } catch (error) {
    logReporterAuthError('challenge-session', {
      route: '/api/reporter-auth/challenge-session',
      normalizedEmail: normalizeEmail(req.query?.email || req.body?.email || ''),
      authModel: req?.reporterPortalAuthModel || 'none',
      sessionPresent: !!req?.session?.reporter,
      sessionExists: !!req?.session,
      verified: false,
      returnedStatusCode: 500,
      errorMessage: error?.message || String(error),
    });
    return res.status(500).json({ ok: false, code: 'CHALLENGE_SESSION_LOAD_FAILED', message: 'Failed to load reporter challenge session.' });
  }
});

router.get('/auth/session', requireReporterPortalOpen, async (req, res) => {
  const handleVerifiedSession = async () => {
    logReporterAuth('session', buildReporterDataLogContext(req, {
      route: '/api/reporter-auth/session',
      verified: !!req.reporterPortal,
      returnedStatusCode: null,
      action: 'start',
    }));
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const { summary } = buildSummary(submissions);
    const expiresAt = req.reporterPortalTokenPayload && req.reporterPortalTokenPayload.exp
      ? new Date(req.reporterPortalTokenPayload.exp * 1000)
      : null;

    logReporterAuth('session', buildReporterDataLogContext(req, {
      route: '/api/reporter-auth/session',
      verified: !!req.reporterPortal,
      resultCount: submissions.length,
      totalRecordsFound: submissions.length,
      reasonForZero: submissions.length === 0 ? 'no-records-found' : null,
      returnedStatusCode: 200,
      action: 'success',
    }));

    return res.status(200).json({
      ok: true,
      reporter: {
        id: req.reporterPortal.reporterId,
        email: req.reporterPortal.email,
        fullName: req.reporterPortal.fullName,
        reporterType: req.reporterPortal.reporterType,
        verificationLevel: req.reporterPortal.verificationLevel,
        status: req.reporterPortal.status,
      },
      session: {
        expiresAt,
      },
      portal: req.reporterPortalState || null,
      summary,
    });
  };

  try {
    if (isReporterAuthCompatRequest(req)) {
      const requestedEmail = normalizeEmail(req.query?.email || req.body?.email || '');
      const pendingResult = await resolveReporterPendingLoginChallenge(req, requestedEmail || null, { compatRequired: false });
      if (pendingResult.ok) {
        return res.status(200).json({
          ok: true,
          authenticated: false,
          reporter: null,
          challenge: {
            challengeId: pendingResult.pending.challengeId,
            email: pendingResult.pending.email,
            emailMasked: maskEmail(pendingResult.pending.email),
            expiresAt: pendingResult.pending.expiresAt || null,
            status: 'pending',
          },
          session: {
            expiresAt: pendingResult.pending.expiresAt || null,
            status: 'pending',
          },
          portal: req.reporterPortalState || null,
        });
      }

      if (pendingResult.reason && pendingResult.reason !== 'missing') {
        clearReporterPortalLoginChallengeCookie(res, req);
        await clearReporterLoginChallengeSession(req).catch(() => null);
        const failure = buildReporterOtpFailure(pendingResult.reason || 'session_missing');
        return res.status(failure.statusCode).json(failure.body);
      }

      const { token } = getReporterPortalTokenDetails(req);
      if (!token) {
        const failure = buildReporterOtpFailure('session_missing');
        return res.status(failure.statusCode).json(failure.body);
      }
    }

    return requireReporterPortalAuth(req, res, (authError) => {
      if (authError) {
        logReporterAuthError('session', buildReporterDataLogContext(req, {
          route: '/api/reporter-auth/session',
          verified: !!req.reporterPortal,
          returnedStatusCode: 500,
          errorMessage: authError?.message || String(authError),
        }));
        return res.status(500).json({ ok: false, code: 'SESSION_LOAD_FAILED', message: 'Failed to load reporter session.' });
      }

      return handleVerifiedSession().catch((error) => {
        logReporterAuthError('session', buildReporterDataLogContext(req, {
          route: '/api/reporter-auth/session',
          verified: !!req.reporterPortal,
          returnedStatusCode: 500,
          errorMessage: error?.message || String(error),
        }));
        return res.status(500).json({ ok: false, code: 'SESSION_LOAD_FAILED', message: 'Failed to load reporter session.' });
      });
    });
  } catch (error) {
    logReporterAuthError('session', buildReporterDataLogContext(req, {
      route: '/api/reporter-auth/session',
      verified: !!req.reporterPortal,
      returnedStatusCode: 500,
      errorMessage: error?.message || String(error),
    }));
    return res.status(500).json({ ok: false, code: 'SESSION_LOAD_FAILED', message: 'Failed to load reporter session.' });
  }
});

router.get('/dashboard/summary', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    logReporterDashboard('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/dashboard/summary',
      returnedStatusCode: null,
      action: 'start',
    }));
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const { summary } = buildSummary(submissions);
    logReporterDashboard('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/dashboard/summary',
      action: 'success',
      totalRecordsFound: submissions.length,
      resultCount: submissions.length,
      reasonForZero: submissions.length === 0 ? 'no-records-found' : null,
      returnedStatusCode: 200,
    }));
    return res.status(200).json({ ok: true, summary });
  } catch (error) {
    logReporterDashboardError('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/dashboard/summary',
      returnedStatusCode: 500,
      errorMessage: error?.message || String(error),
    }));
    return res.status(500).json({ ok: false, code: 'DASHBOARD_SUMMARY_FAILED', message: 'Failed to load dashboard summary.' });
  }
});

router.get('/submissions/stats', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    logReporterDashboard('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/submissions/stats',
      returnedStatusCode: null,
      action: 'start',
    }));
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const stats = buildSummary(submissions);
    logReporterDashboard('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/submissions/stats',
      action: 'success',
      totalRecordsFound: submissions.length,
      resultCount: submissions.length,
      reasonForZero: submissions.length === 0 ? 'no-records-found' : null,
      returnedStatusCode: 200,
    }));
    return res.status(200).json({ ok: true, ...stats });
  } catch (error) {
    logReporterDashboardError('stats', buildReporterDataLogContext(req, {
      route: '/api/reporter-portal/submissions/stats',
      returnedStatusCode: 500,
      errorMessage: error?.message || String(error),
    }));
    return res.status(500).json({ ok: false, code: 'SUBMISSION_STATS_FAILED', message: 'Failed to load submission stats.' });
  }
});

router.get('/submissions', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query && req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query && req.query.limit || '20', 10), 1), 100);
    const status = String(req.query && req.query.status || '').trim();
    const q = String(req.query && req.query.q || '').trim().toLowerCase();
    logReporterSubmissions('list', buildReporterSubmissionLogContext(req, {
      returnedStatusCode: null,
      action: 'start',
    }));

    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const filtered = submissions.filter((submission) => {
      if (!matchesPortalStatus(submission, status)) return false;
      if (!q) return true;
      const haystack = [submission.headline, submission.body, submission.category, submission.desk, submission.track]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      return haystack.includes(q);
    });

    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit).map(mapSubmission);
    logReporterSubmissions('list', buildReporterSubmissionLogContext(req, {
      action: 'success',
      resultCount: items.length,
      totalRecordsFound: submissions.length,
      total: filtered.length,
      reasonForZero: submissions.length === 0 ? 'no-records-found' : (filtered.length === 0 ? 'filtered-empty' : null),
      returnedStatusCode: 200,
    }));

    return res.status(200).json({
      ok: true,
      items,
      total: filtered.length,
      meta: {
        total: filtered.length,
        page,
        limit,
      },
    });
  } catch (error) {
    logReporterSubmissionsError('list', buildReporterSubmissionLogContext(req, {
      action: 'error',
      returnedStatusCode: 500,
      errorMessage: error?.message || String(error),
    }));
    return res.status(500).json({ ok: false, code: 'REPORTER_SUBMISSIONS_FETCH_FAILED', message: 'Failed to load submissions.' });
  }
});

router.get('/submissions/:id', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const id = String(req.params && req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, code: 'INVALID_SUBMISSION_ID', message: 'Invalid submission id.' });
    }

    const filter = buildReporterOwnershipFilter(req.reporterPortal);
    const submission = await CommunitySubmission.findOne({ _id: id, ...filter });
    if (!submission) {
      return res.status(404).json({ ok: false, code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' });
    }

    return res.status(200).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][submission-detail] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_DETAIL_FAILED', message: 'Failed to load submission detail.' });
  }
});

router.post('/submissions', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(403).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const status = toStoredStatusForCreate(req.body && req.body.action);
    const headline = String(req.body && req.body.headline || '').trim();
    const story = String(req.body && (req.body.story || req.body.body) || '').trim();
    const normalizedCategory = normalizeCommunityReporterCategory(req.body && req.body.category);

    if (status === 'SUBMITTED' && (!headline || !story)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Headline and story are required before submission.' });
    }
    if (status === 'DRAFT' && !headline && !story) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Draft must contain a headline or story.' });
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'category') && !normalizedCategory) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `Category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`,
      });
    }
    if (!normalizedCategory) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `Category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`,
      });
    }

    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    logReporterContactPipeline({
      stage: 'portal.submit.incoming',
      email: req.reporterPortal.email,
      incomingPhone: req.body && (req.body.phone || req.body.contactPhone || null),
      incomingWhatsapp: req.body && (req.body.whatsapp || req.body.whatsappNumber || null),
      incomingCity: req.body && (req.body.city || (req.body.location && req.body.location.city) || reporterDoc.cityTownVillage || null),
      incomingDistrict: req.body && (req.body.district || (req.body.location && req.body.location.district) || reporterDoc.districtName || null),
      incomingState: req.body && (req.body.state || (req.body.location && req.body.location.state) || reporterDoc.stateName || null),
      incomingCountry: req.body && (req.body.country || (req.body.location && req.body.location.country) || reporterDoc.country || null),
      incomingBeat: req.body && (req.body.beat || req.body.primaryBeat || reporterDoc.primaryBeat || null),
      incomingArea: req.body && (req.body.area || (req.body.location && req.body.location.area) || reporterDoc.areaName || null),
      incomingAreaType: req.body && (req.body.areaType || reporterDoc.areaType || null),
      incomingCoverageScope: req.body && (req.body.coverageScope || reporterDoc.coverageScope || null),
      incomingOrganisation: req.body && (req.body.organisationName || req.body.organizationName || req.body.organization || reporterDoc.organisationName || null),
      reporterContactId: reporterDoc && reporterDoc._id ? String(reporterDoc._id) : null,
    });
    await upsertReporterContactFromPayload({
      name: reporterDoc.fullName,
      email: req.reporterPortal.email,
      phone: req.body && (req.body.phone || req.body.contactPhone),
      whatsapp: req.body && (req.body.whatsapp || req.body.whatsappNumber),
      city: req.body && (req.body.city || (req.body.location && req.body.location.city) || reporterDoc.cityTownVillage),
      district: req.body && (req.body.district || (req.body.location && req.body.location.district) || reporterDoc.districtName),
      state: req.body && (req.body.state || (req.body.location && req.body.location.state) || reporterDoc.stateName),
      country: req.body && (req.body.country || (req.body.location && req.body.location.country) || reporterDoc.country),
      beat: req.body && (req.body.beat || req.body.primaryBeat || reporterDoc.primaryBeat),
      area: req.body && (req.body.area || (req.body.location && req.body.location.area) || reporterDoc.areaName),
      areaType: req.body && (req.body.areaType || reporterDoc.areaType),
      coverageScope: req.body && (req.body.coverageScope || reporterDoc.coverageScope),
      organisationName: req.body && (req.body.organisationName || req.body.organizationName || req.body.organization || reporterDoc.organisationName),
      portalAccessEnabled: reporterDoc.portalAccessEnabled !== false,
      portalAuthVersion: typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0,
      reporterType: reporterDoc.reporterType || 'community',
    }).catch(() => null);

    const deskMeta = inferSubmissionDeskMetadata(req.body || {});
    const attachments = extractSubmissionAttachments(req.body || {});
    const submission = await CommunitySubmission.create({
      reporterName: reporterDoc.fullName || 'Reporter',
      reporterEmail: req.reporterPortal.email,
      reporterEmailNorm: req.reporterPortal.email,
      name: reporterDoc.fullName || 'Reporter',
      email: req.reporterPortal.email,
      headline,
      body: story,
      category: normalizedCategory,
      desk: deskMeta.desk || null,
      submissionType: deskMeta.submissionType || null,
      intakeSource: deskMeta.intakeSource || 'reporter_portal',
      track: deskMeta.track || null,
      status,
      reporterId: reporterDoc._id,
      sourceType: reporterDoc.reporterType === 'journalist' ? 'journalist' : 'community',
      reporterVerificationLevel: mapVerificationLevelForSubmission(reporterDoc),
      phone: String(req.body && (req.body.phone || req.body.contactPhone) || '').trim() || undefined,
      phoneNumber: String(req.body && (req.body.phone || req.body.contactPhone) || '').trim() || undefined,
      contactNumber: String(req.body && (req.body.phone || req.body.contactPhone) || '').trim() || undefined,
      whatsapp: String(req.body && (req.body.whatsapp || req.body.whatsappNumber) || '').trim() || undefined,
      whatsappNumber: String(req.body && (req.body.whatsapp || req.body.whatsappNumber) || '').trim() || undefined,
      city: String(req.body && (req.body.city || (req.body.location && req.body.location.city) || reporterDoc.cityTownVillage) || '').trim() || undefined,
      district: String(req.body && (req.body.district || (req.body.location && req.body.location.district) || reporterDoc.districtName) || '').trim() || undefined,
      state: String(req.body && (req.body.state || (req.body.location && req.body.location.state) || reporterDoc.stateName) || '').trim() || undefined,
      country: String(req.body && (req.body.country || (req.body.location && req.body.location.country) || reporterDoc.country) || '').trim() || undefined,
      area: String(req.body && (req.body.area || (req.body.location && req.body.location.area) || reporterDoc.areaName) || '').trim() || undefined,
      areaType: String(req.body && (req.body.areaType || reporterDoc.areaType) || '').trim() || undefined,
      coverageScope: String(req.body && (req.body.coverageScope || reporterDoc.coverageScope) || '').trim() || undefined,
      beat: String(req.body && (req.body.beat || req.body.primaryBeat || reporterDoc.primaryBeat) || '').trim() || undefined,
      organisationName: String(req.body && (req.body.organisationName || req.body.organizationName || req.body.organization || reporterDoc.organisationName) || '').trim() || undefined,
      organisationType: String(req.body && (req.body.organisationType || req.body.organizationType || reporterDoc.organisationType) || '').trim() || undefined,
      portalAccessEnabled: reporterDoc.portalAccessEnabled !== false,
      portalAuthVersion: typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0,
      portalAuthStatus: reporterDoc.portalAccessEnabled === false ? 'disabled' : 'authenticated',
      contact: {
        name: reporterDoc.fullName || 'Reporter',
        email: req.reporterPortal.email,
        phone: String(req.body && (req.body.phone || req.body.contactPhone) || '').trim() || undefined,
        whatsappNumber: String(req.body && (req.body.whatsapp || req.body.whatsappNumber) || '').trim() || undefined,
      },
      attachments,
      mediaUrl: attachments[0] && attachments[0].url ? attachments[0].url : undefined,
      mediaLink: attachments[0] && attachments[0].url ? attachments[0].url : undefined,
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    applySubmissionPatch(submission, req.body || {}, reporterDoc);
    if (typeof submission.save === 'function') {
      await submission.save();
    }

    logReporterContactPipeline({
      stage: 'portal.submit.stored-submission',
      email: submission.reporterEmailNorm || submission.reporterEmail || submission.email || null,
      incomingPhone: req.body && (req.body.phone || req.body.contactPhone || null),
      incomingWhatsapp: req.body && (req.body.whatsapp || req.body.whatsappNumber || null),
      storedPhone: submission.phone || submission.phoneNumber || submission.contactNumber || submission.contact?.phone || null,
      storedWhatsapp: submission.whatsapp || submission.whatsappNumber || submission.contact?.whatsappNumber || null,
      storedCity: submission.city || submission.location?.city || submission.locationDetail?.city || null,
      storedDistrict: submission.district || submission.locationDetail?.district || null,
      storedState: submission.state || submission.location?.state || submission.locationDetail?.state || null,
      storedCountry: submission.country || submission.location?.country || submission.locationDetail?.country || null,
      storedArea: submission.area || null,
      storedAreaType: submission.areaType || null,
      storedCoverageScope: submission.coverageScope || null,
      storedBeat: submission.beat || null,
      storedOrganisation: submission.organisationName || null,
      reporterContactId: submission.reporterId ? String(submission.reporterId) : (reporterDoc && reporterDoc._id ? String(reporterDoc._id) : null),
    });

    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    return res.status(201).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][create-submission] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_CREATE_FAILED', message: 'Failed to create submission.' });
  }
});

router.patch('/submissions/:id', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const id = String(req.params && req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, code: 'INVALID_SUBMISSION_ID', message: 'Invalid submission id.' });
    }

    const filter = buildReporterOwnershipFilter(req.reporterPortal);
    const submission = await CommunitySubmission.findOne({ _id: id, ...filter });
    if (!submission) {
      return res.status(404).json({ ok: false, code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' });
    }

    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'category') && !normalizeCommunityReporterCategory(req.body.category)) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `Category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`,
      });
    }

    if (!canEditSubmission(submission)) {
      return res.status(409).json({ ok: false, code: 'SUBMISSION_NOT_EDITABLE', message: 'This submission can no longer be edited.' });
    }

    const nextStatus = toStoredStatusForUpdate(getSubmissionPortalStatus(submission), req.body && req.body.action);
    applySubmissionPatch(submission, req.body || {}, req.reporterPortal);

    if (nextStatus === 'SUBMITTED' && (!String(submission.headline || '').trim() || !String(submission.body || '').trim())) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Headline and story are required before submission.' });
    }

    if (nextStatus) submission.status = nextStatus;
    submission.reporterId = submission.reporterId || req.reporterPortal.reporterId;
    submission.reporterEmailNorm = submission.reporterEmailNorm || req.reporterPortal.email;

    await submission.save();

    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    return res.status(200).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][update-submission] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_UPDATE_FAILED', message: 'Failed to update submission.' });
  }
});

router.resetRateLimitsForTests = function resetRateLimitsForTests() {
  otpRequestAttempts.clear();
  otpVerifyAttempts.clear();
};

module.exports = router;