const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const CommunitySubmission = require('../models/CommunitySubmission');
const OtpToken = require('../models/OtpToken');
const ReporterContact = require('../models/ReporterContact');
const ActivityLog = require('../models/ActivityLog');
const { sendMail, getTransporter, getMailerStatus } = require('../lib/mailer');
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
} = require('../middleware/reporterPortalAuth');

const router = express.Router();

const REPORTER_PORTAL_OTP_PURPOSE = 'reporter_portal_login';
const REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE = 'reporter_portal_email_change';
const OTP_EXPIRY_MS = 10 * 60 * 1000;
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
  const productionLike = isProductionLike();
  return {
    httpOnly: true,
    sameSite: productionLike ? 'none' : 'lax',
    secure: productionLike,
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

function isLocalhostRequest(req) {
  const origin = String(req.get('Origin') || '').trim();
  const host = String(req.get('Host') || '').trim();
  const target = origin || (host ? `http://${host}` : '');
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(target);
}

function getReporterPortalCookieOptions(req, expiresAt) {
  const localRequest = isLocalhostRequest(req) || !isHttpsRequest(req);
  return {
    httpOnly: true,
    sameSite: localRequest ? 'lax' : 'none',
    secure: localRequest ? false : true,
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

function setReporterPortalSessionCookie(res, req, token, expiresAt) {
  res.cookie(REPORTER_PORTAL_COOKIE_NAME, token, getReporterPortalCookieOptions(req, expiresAt));
}

function clearReporterPortalSessionCookie(res, req) {
  res.clearCookie(REPORTER_PORTAL_COOKIE_NAME, getReporterPortalCookieOptions(req));
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

function createEmailServiceUnavailableError(error) {
  const wrapped = new Error(error?.message || 'Verification email service unavailable');
  wrapped.code = error?.code || 'REPORTER_EMAIL_UNAVAILABLE';
  wrapped.responseCode = error?.responseCode;
  wrapped.command = error?.command;
  wrapped.errno = error?.errno;
  wrapped.syscall = error?.syscall;
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
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : !!req?.session?.reporter,
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
    authModel: extra.authModel || req?.reporterPortalAuthModel || (req?.session?.reporter ? 'session' : (req?.reporterPortalTokenPayload ? 'token' : 'none')),
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : !!req?.session?.reporter,
    sessionExists: !!req?.session?.reporter,
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
    sessionPresent: extra.sessionPresent !== undefined ? extra.sessionPresent : !!req?.session?.reporter,
    sessionExists: !!req?.session?.reporter,
    verified: extra.verified !== undefined ? extra.verified : !!req?.reporterPortal,
    reporterProfileFound: !!req?._reporterPortalDoc,
    resultCount: 0,
    authModel: req?.reporterPortalAuthModel || (req?.session?.reporter ? 'session' : (req?.reporterPortalTokenPayload ? 'token' : 'none')),
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

  if (mailerStatus.stubMode && isProductionLike()) {
    transporterReady = false;
    transporterError = 'EMAIL_MODE=stub is not allowed in production-like environments';
  } else if (!mailerStatus.stubMode && mailerStatus.configured) {
    try {
      transporterReady = !!getTransporter();
      if (!transporterReady) {
        transporterError = 'Reporter mail transporter returned null';
      }
    } catch (error) {
      transporterReady = false;
      transporterError = error?.message || String(error);
    }
  } else if (!mailerStatus.configured) {
    transporterError = mailerStatus.missing.length
      ? `Missing mailer env: ${mailerStatus.missing.join(', ')}`
      : 'Reporter mailer is not configured';
  }

  return {
    ...mailerStatus,
    transporterReady,
    transporterError,
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

function getOtpResendCooldownMs() {
  return Math.max(Number(process.env.REPORTER_OTP_RESEND_COOLDOWN_MS || 60 * 1000), 0);
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
  const stubMode = (process.env.EMAIL_MODE || '').toLowerCase() === 'stub';

  console.log('[reporter-portal][mail][prepare]', buildOtpLogContext({
    originalUrl: '/api/reporter-auth/request-code',
    url: '/api/reporter-auth/request-code',
    method: 'POST',
    get: () => undefined,
    headers: {},
    ip: 'internal',
    socket: null,
  }, email, {
    mode: stubMode ? 'stub' : 'smtp',
    baseUrl,
  }));

  if (stubMode) {
    if (isProductionLike()) {
      throw createEmailServiceUnavailableError({ message: 'EMAIL_MODE=stub is not allowed in production', code: 'EMAIL_STUB_FORBIDDEN' });
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
      hasTransporter: !!transporter,
      productionLike: isProductionLike(),
      baseUrlConfigured: !!baseUrl,
    });
  } catch (error) {
    console.error('[reporter-portal][mail][transporter-failed]', {
      emailMasked: maskEmail(email),
      error: serializeError(error),
    });
    throw createEmailServiceUnavailableError(error);
  }
  if (!transporter) throw createEmailServiceUnavailableError({ message: 'Email transporter not configured', code: 'EMAIL_TRANSPORTER_MISSING' });

  let info;
  try {
    info = await sendMail({ to: email, subject, text, html: `<p>${text}</p>` });
  } catch (error) {
    console.error('[reporter-portal][mail][send-failed]', {
      emailMasked: maskEmail(email),
      error: serializeError(error),
    });
    if (isRecipientDeliveryIssue(error)) {
      throw createAcceptedOtpRequestError(error);
    }
    throw createEmailServiceUnavailableError(error);
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
    mode: 'smtp',
    acceptedCount: accepted.length,
  });
  return { method: 'email' };
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
        transporterReady: mailerStatus.transporterReady,
        missing: mailerStatus.missing,
        resolved: mailerStatus.resolved,
        errorMessage: mailerStatus.transporterError,
      });
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_EMAIL_UNAVAILABLE',
        message: 'Verification email service is temporarily unavailable.',
      });
    }

    const rateLimitKey = getRateLimitKey(req, email);
    const requestLimit = consumeRateLimit(otpRequestAttempts, rateLimitKey, OTP_REQUEST_RATE_LIMIT);
    if (requestLimit.limited) {
      await logReporterActivity('reporter_portal_otp_request_rate_limited', email, { ip: getClientIp(req) });
      return res.status(429).json({ ok: false, code: 'OTP_REQUEST_RATE_LIMITED', message: 'Too many OTP requests. Please try again later.' });
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

    const existingOtp = await OtpToken.findOne({ email, purpose: REPORTER_PORTAL_OTP_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (existingOtp && existingOtp.createdAt && existingOtp.expiresAt && new Date(existingOtp.expiresAt) > new Date()) {
      const elapsedMs = Date.now() - new Date(existingOtp.createdAt).getTime();
      const cooldownMs = getOtpResendCooldownMs();
      if (elapsedMs < cooldownMs) {
        const retryAfterSec = Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000));
        await logReporterActivity('reporter_portal_otp_request_cooldown_active', email, { ip: getClientIp(req), retryAfterSec });
        return res.status(429).json({
          ok: false,
          code: 'COOLDOWN_ACTIVE',
          message: 'Please wait before requesting another verification code.',
          retryAfterSec,
        });
      }
    }

    await OtpToken.updateMany(
      { email, purpose: REPORTER_PORTAL_OTP_PURPOSE, used: false },
      { $set: { used: true } }
    );

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    logReporterAuth('request-code', buildOtpLogContext(req, email, {
      route: '/api/reporter-auth/request-code',
      action: 'otp-generated',
      returnedStatusCode: null,
      expiresAt: expiresAt.toISOString(),
      otpLength: code.length,
    }));
    const codeHash = await bcrypt.hash(code, 10);
    createdOtpRecord = await OtpToken.create({ email, purpose: REPORTER_PORTAL_OTP_PURPOSE, codeHash, expiresAt, used: false });
    await sendReporterOtpEmail(email, code);
    await logReporterActivity('reporter_portal_otp_requested', email, { ip: getClientIp(req), reporterId: reporter && reporter._id ? String(reporter._id) : null });
    logReporterAuth('request-code', {
      route: '/api/reporter-auth/request-code',
      normalizedEmail: email,
      sessionPresent: !!req?.session?.reporter,
      verified: false,
      returnedStatusCode: 200,
      transporterReady: mailerStatus.transporterReady,
      action: 'otp-sent',
    });

    return res.status(200).json({
      ...buildOtpAcceptedResponse(email),
      ...(shouldExposeDevOtp() ? { devCode: code } : {}),
    });
  } catch (error) {
    if (createdOtpRecord && createdOtpRecord.used === false && typeof createdOtpRecord.save === 'function') {
      try {
        createdOtpRecord.used = true;
        await createdOtpRecord.save();
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
      transporterReady: false,
      errorMessage: error?.message || String(error),
      error: serializeError(error),
    });
    if (error && error.safeClientCode === 'REPORTER_EMAIL_UNAVAILABLE') {
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_EMAIL_UNAVAILABLE',
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

    const otpRecord = await OtpToken.findOne({ email, purpose: REPORTER_PORTAL_OTP_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.expiresAt || new Date() > new Date(otpRecord.expiresAt)) {
      await logReporterActivity('reporter_portal_otp_verify_failed', email, { ip: getClientIp(req), reason: 'expired_or_missing' });
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    const matches = await bcrypt.compare(otp, otpRecord.codeHash);
    if (!matches) {
      await logReporterActivity('reporter_portal_otp_verify_failed', email, { ip: getClientIp(req), reason: 'invalid_code' });
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    clearRateLimit(otpVerifyAttempts, rateLimitKey);

    otpRecord.used = true;
    if (typeof otpRecord.save === 'function') {
      await otpRecord.save();
    }

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

    reporter.lastPortalLoginAt = new Date();
    if (typeof reporter.save === 'function') {
      await reporter.save();
    } else {
      await ReporterContact.findOneAndUpdate({ _id: reporter._id }, { $set: { lastPortalLoginAt: new Date() } });
    }

    await backfillReporterOwnership(reporter);

    const token = buildReporterToken(reporter);
    const expiresAt = getTokenExpiresAt(token);
    const submissions = await loadOwnedSubmissions({ reporterId: reporter._id, email });
    const { summary } = buildSummary(submissions);
    await logReporterActivity('reporter_portal_login', email, { ip: getClientIp(req), reporterId: String(reporter._id), expiresAt });
    await saveReporterSession(req, reporter);
    setReporterPortalSessionCookie(res, req, token, expiresAt);
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
    clearReporterPortalSessionCookie(res, req);
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

    await OtpToken.updateMany(
      { email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, used: false },
      { $set: { used: true } }
    );

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    const codeHash = await bcrypt.hash(code, 10);
    await OtpToken.create({ email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, codeHash, expiresAt, used: false });

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

    const otpRecord = await OtpToken.findOne({ email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.expiresAt || new Date() > new Date(otpRecord.expiresAt)) {
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    const matches = await bcrypt.compare(otp, otpRecord.codeHash);
    if (!matches) {
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    clearRateLimit(otpVerifyAttempts, verifyLimitKey);

    otpRecord.used = true;
    if (typeof otpRecord.save === 'function') {
      await otpRecord.save();
    }

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

router.get('/auth/session', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
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