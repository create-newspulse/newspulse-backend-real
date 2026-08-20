const crypto = require('crypto');

const ReporterSession = require('../models/ReporterSession');
const { normalizeEmail } = require('../lib/normalizeEmail');

const REPORTER_SESSION_TOKEN_PREFIX = 'rps_';
const DEFAULT_REPORTER_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

function parseDurationMs(value, fallbackMs = DEFAULT_REPORTER_SESSION_DURATION_MS) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallbackMs;

  if (/^\d+$/.test(raw)) return Math.max(1, Number(raw)) * 1000;

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;

  const unit = match[2];
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return Math.max(1, Math.floor(amount * multipliers[unit]));
}

function getReporterSessionExpiresIn() {
  return String(process.env.REPORTER_PORTAL_SESSION_EXPIRES_IN || process.env.REPORTER_PORTAL_JWT_EXPIRES_IN || '24h').trim() || '24h';
}

function getReporterSessionDurationMs() {
  return parseDurationMs(getReporterSessionExpiresIn());
}

function getReporterSessionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + getReporterSessionDurationMs());
}

function generateReporterSessionToken() {
  return `${REPORTER_SESSION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function isReporterSessionToken(token) {
  return String(token || '').startsWith(REPORTER_SESSION_TOKEN_PREFIX);
}

function hashReporterSessionToken(token) {
  return ReporterSession.hashToken(token);
}

function getClientIp(req) {
  return String(
    req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.ip
    || req?.socket?.remoteAddress
    || ''
  );
}

function buildReporterSessionPayload(session) {
  const expiresAt = session?.expiresAt ? new Date(session.expiresAt) : null;
  return {
    sub: session?.reporterId ? String(session.reporterId) : null,
    reporterId: session?.reporterId ? String(session.reporterId) : null,
    email: normalizeEmail(session?.email) || null,
    portalAuthVersion: typeof session?.portalAuthVersion === 'number' ? session.portalAuthVersion : 0,
    type: 'reporter_portal_session',
    exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : undefined,
  };
}

async function createReporterSession(reporter, options = {}) {
  if (!reporter?._id) throw new Error('Reporter id is required for session creation');
  const token = generateReporterSessionToken();
  const expiresAt = options.expiresAt || getReporterSessionExpiresAt(options.now || new Date());
  const session = await ReporterSession.create({
    reporterId: reporter._id,
    email: normalizeEmail(reporter.email || reporter.emailLower),
    tokenHash: hashReporterSessionToken(token),
    portalAuthVersion: typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0,
    expiresAt,
    lastSeenAt: options.now || new Date(),
    userAgent: options.req?.get ? String(options.req.get('user-agent') || '').slice(0, 500) || null : null,
    ipAddress: getClientIp(options.req) || null,
  });

  return { token, session, expiresAt };
}

async function validateReporterSessionToken(token, options = {}) {
  if (!isReporterSessionToken(token)) return { ok: false, reason: 'format' };

  const now = options.now || new Date();
  const session = await ReporterSession.findOne({ tokenHash: hashReporterSessionToken(token) });
  if (!session) return { ok: false, reason: 'missing' };
  if (session.revokedAt) return { ok: false, reason: 'revoked', session };
  if (!session.expiresAt || new Date(session.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired', session };
  }

  if (options.touch !== false) {
    try {
      session.lastSeenAt = now;
      if (typeof session.save === 'function') await session.save();
    } catch (_) {}
  }

  return {
    ok: true,
    session,
    payload: buildReporterSessionPayload(session),
  };
}

async function revokeReporterSessionToken(token, reason = 'logout') {
  if (!isReporterSessionToken(token)) return { ok: false, reason: 'format' };
  const session = await ReporterSession.findOne({ tokenHash: hashReporterSessionToken(token) });
  if (!session) return { ok: false, reason: 'missing' };
  if (!session.revokedAt) {
    session.revokedAt = new Date();
    session.revokedReason = reason;
    if (typeof session.save === 'function') await session.save();
  }
  return { ok: true, session };
}

async function revokeReporterSessionsForReporter(reporterId, reason = 'revoked') {
  if (!reporterId) return { acknowledged: true, modifiedCount: 0 };
  return ReporterSession.updateMany(
    { reporterId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
}

module.exports = {
  REPORTER_SESSION_TOKEN_PREFIX,
  buildReporterSessionPayload,
  createReporterSession,
  getReporterSessionDurationMs,
  getReporterSessionExpiresAt,
  getReporterSessionExpiresIn,
  hashReporterSessionToken,
  isReporterSessionToken,
  parseDurationMs,
  revokeReporterSessionToken,
  revokeReporterSessionsForReporter,
  validateReporterSessionToken,
};