const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const ReporterContact = require('../models/ReporterContact');
const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');
const { normalizeEmail } = require('../lib/normalizeEmail');

const REPORTER_PORTAL_COOKIE_NAME = 'reporter_portal_session';

function logReporterSession(payload) {
  console.log('[reporter-auth][session]', payload);
}

function logReporterSessionError(payload) {
  console.error('[reporter-auth][session]', payload);
const OtpToken = require('../models/OtpToken');
const REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME = 'reporter_portal_login_challenge';
const REPORTER_PORTAL_LOGIN_CHALLENGE_PURPOSE = 'reporter_portal_login';
}

function logReporterSubmissionsAuth(payload) {
  console.log('[reporter-submissions][auth]', payload);
}

function logReporterSubmissionsAuthError(payload) {
  console.error('[reporter-submissions][auth]', payload);
}

function buildReporterAuthLogContext(req, extra = {}) {
  const normalizedEmail = normalizeEmail(
    extra.normalizedEmail
    || req?.reporterPortal?.email
    || req?.body?.email
    || req?.query?.email
    || req?.reporterPortalTokenPayload?.email
  ) || null;

  return {
    route: extra.route || String(req?.originalUrl || req?.url || ''),
    normalizedEmail,
    authModel: extra.authModel || req?.reporterPortalAuthModel || 'none',
    sessionExists: !!req?.session?.reporter,
    verified: extra.verified !== undefined ? extra.verified : !!req?.reporterPortal,
    collectionsQueried: extra.collectionsQueried || [],
    totalRecordsFound: extra.totalRecordsFound ?? 0,
    reasonForZero: extra.reasonForZero || null,
    ...extra,
  };
}

function isReporterSessionRequest(req) {
  const path = String(req?.originalUrl || req?.url || '');
  return /\/auth\/session(?:$|\?)/i.test(path);
}

function isReporterAuthCompatRequest(req) {
  const path = String(req?.originalUrl || req?.url || '');
  return req?.reporterAuthCompat === true || /\/api\/reporter-auth(?:\/|$)/i.test(path);
}

function isReporterSubmissionsRequest(req) {
  const path = String(req?.originalUrl || req?.url || '');
  return /\/submissions(?:$|\/|\?)/i.test(path);
}

function respondReporterSessionMissing(req, res, errorMessage) {
  const payload = buildReporterAuthLogContext(req, {
    verified: false,
    errorMessage,
    reasonForZero: 'auth-missing',
    collectionsQueried: ['CommunitySubmission'],
  });

  if (isReporterSessionRequest(req)) {
    logReporterSessionError(payload);
  }
  if (isReporterSubmissionsRequest(req)) {
    logReporterSubmissionsAuthError(payload);
  }

  return res.status(401).json({
    ok: false,
    code: 'REPORTER_SESSION_MISSING',
    message: 'Reporter session missing or expired.',
  });
}

function respondReporterSessionExpired(req, res, errorMessage) {
  const payload = buildReporterAuthLogContext(req, {
    verified: false,
    errorMessage,
    reasonForZero: 'session-expired',
    collectionsQueried: ['CommunitySubmission'],
  });

  if (isReporterSessionRequest(req)) {
    logReporterSessionError(payload);
  }
  if (isReporterSubmissionsRequest(req)) {
    logReporterSubmissionsAuthError(payload);
  }

  return res.status(401).json({
    ok: false,
    code: 'SESSION_EXPIRED',
    message: 'Session expired. Request a new verification code.',
  });
}

function getReporterLoginChallengeCookieToken(req) {
  const cookieToken = req && req.cookies ? req.cookies[REPORTER_PORTAL_LOGIN_CHALLENGE_COOKIE_NAME] : null;
  const token = String(cookieToken || '').trim();
  return token || null;
}

function getReporterChallengeSecret() {
  return String(process.env.REPORTER_PORTAL_SESSION_SECRET || process.env.REPORTER_SESSION_SECRET || process.env.JWT_SECRET || '').trim();
}

function decodeReporterLoginChallengeToken(req) {
  const token = getReporterLoginChallengeCookieToken(req);
  if (!token) return null;
  const secret = getReporterChallengeSecret();
  if (!secret) return null;

  const payload = jwt.verify(token, secret);
  if (payload?.type !== 'reporter_portal_login_challenge') return null;

  return {
    challengeId: payload.challengeId ? String(payload.challengeId) : null,
    email: normalizeEmail(payload.email) || null,
    purpose: payload.purpose ? String(payload.purpose) : REPORTER_PORTAL_LOGIN_CHALLENGE_PURPOSE,
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
  };
}

function resolveOtpChallengeStatus(challenge, now = new Date()) {
  if (!challenge || typeof challenge !== 'object') return null;
  const rawStatus = String(challenge.status || '').trim().toLowerCase();
  if (['active', 'expired', 'consumed', 'replaced'].includes(rawStatus)) return rawStatus;
  if (challenge.consumedAt || challenge.used === true) return 'consumed';
  if (challenge.expiresAt && new Date(challenge.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

async function resolveCompatPendingChallenge(req) {
  const pending = decodeReporterLoginChallengeToken(req);
  if (!pending || !pending.challengeId || !pending.email) return { ok: false, reason: 'missing' };
  if (!isDbReady()) return { ok: true, pending, reason: 'cookie_only' };

  const challenge = await OtpToken.findOne({
    email: pending.email,
    purpose: pending.purpose || REPORTER_PORTAL_LOGIN_CHALLENGE_PURPOSE,
    challengeId: pending.challengeId,
  });

  if (!challenge) return { ok: false, reason: 'missing', pending };

  const status = resolveOtpChallengeStatus(challenge);
  if (status !== 'active') {
    return { ok: false, reason: status, pending, challenge };
  }

  return {
    ok: true,
    pending: {
      challengeId: pending.challengeId,
      email: pending.email,
      purpose: pending.purpose || REPORTER_PORTAL_LOGIN_CHALLENGE_PURPOSE,
      expiresAt: challenge.expiresAt || pending.expiresAt || null,
    },
    challenge,
    reason: 'active',
  };
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
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
  const bearerToken = getBearerToken(req);
  if (bearerToken) return { token: bearerToken, authModel: 'bearer-token' };

  const cookieToken = getReporterPortalCookieToken(req);
  if (cookieToken) return { token: cookieToken, authModel: 'cookie-token' };

  return { token: null, authModel: 'none' };
}

function getReporterPortalToken(req) {
  return getReporterPortalTokenDetails(req).token;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isPortalClosed(state) {
  if (!state) return false;
  return state.reporterPortalClosed || state.allowMyStoriesPortal === false || state.reporterPortalEnabled === false;
}

async function requireReporterPortalOpen(req, res, next) {
  try {
    const state = await getEffectiveCommunityAccessState();
    req.reporterPortalState = state;

    if (isPortalClosed(state)) {
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_PORTAL_CLOSED',
        message: 'Reporter Portal is currently closed.',
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function normalizeReporterPayload(payload) {
  return {
    reporterId: payload && payload.reporterId ? String(payload.reporterId) : (payload && payload.sub ? String(payload.sub) : null),
    email: normalizeEmail(payload && payload.email) || null,
    fullName: payload && payload.fullName ? String(payload.fullName) : 'Reporter',
    reporterType: payload && payload.reporterType ? String(payload.reporterType) : 'community',
    verificationLevel: payload && payload.verificationLevel ? String(payload.verificationLevel) : 'community_default',
    portalAccessEnabled: payload && typeof payload.portalAccessEnabled === 'boolean' ? payload.portalAccessEnabled : true,
    portalAuthVersion: payload && typeof payload.portalAuthVersion === 'number' ? payload.portalAuthVersion : 0,
    status: payload && payload.status ? String(payload.status) : 'active',
  };
}

function normalizeReporterSession(sessionReporter) {
  return {
    reporterId: sessionReporter && sessionReporter.reporterId ? String(sessionReporter.reporterId) : null,
    email: normalizeEmail(sessionReporter && sessionReporter.email) || null,
    fullName: sessionReporter && sessionReporter.fullName ? String(sessionReporter.fullName) : 'Reporter',
    reporterType: sessionReporter && sessionReporter.reporterType ? String(sessionReporter.reporterType) : 'community',
    verificationLevel: sessionReporter && sessionReporter.verificationLevel ? String(sessionReporter.verificationLevel) : 'community_default',
    portalAccessEnabled: true,
    portalAuthVersion: typeof sessionReporter?.portalAuthVersion === 'number' ? sessionReporter.portalAuthVersion : 0,
    status: sessionReporter && sessionReporter.status ? String(sessionReporter.status) : 'active',
    verified: sessionReporter?.verified === true,
  };
}

async function requireReporterPortalAuth(req, res, next) {
  let payload = null;
  try {
    const sessionReporter = normalizeReporterSession(req?.session?.reporter);
    if (sessionReporter.email && sessionReporter.verified) {
      req.reporterPortalAuthModel = 'session';
      req.reporterPortal = sessionReporter;
      req.reporterPortalTokenPayload = req.reporterPortalTokenPayload || null;

      if (!isDbReady()) {
        if (isReporterSessionRequest(req)) {
          logReporterSession(buildReporterAuthLogContext(req, { normalizedEmail: sessionReporter.email, sessionExists: true, verified: true }));
        }
        if (isReporterSubmissionsRequest(req)) {
          logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { normalizedEmail: sessionReporter.email, sessionExists: true, verified: true }));
        }
        return next();
      }

      let reporter = null;
      if (sessionReporter.reporterId && mongoose.isValidObjectId(String(sessionReporter.reporterId))) {
        reporter = await ReporterContact.findById(sessionReporter.reporterId);
      }
      if (!reporter && sessionReporter.email) {
        reporter = await ReporterContact.findOne({ $or: [{ email: sessionReporter.email }, { emailLower: sessionReporter.email }] });
      }

      if (reporter) {
        req.reporterPortal = {
          reporterId: String(reporter._id),
          email: normalizeEmail(reporter.email || reporter.emailLower) || null,
          fullName: reporter.fullName || 'Reporter',
          reporterType: reporter.reporterType || 'community',
          verificationLevel: reporter.verificationLevel || 'community_default',
          portalAccessEnabled: reporter.portalAccessEnabled !== false,
          portalAuthVersion: typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0,
          status: reporter.status || 'active',
          verified: true,
        };
        req._reporterPortalDoc = reporter;
      }

      if (isReporterSessionRequest(req)) {
        logReporterSession(buildReporterAuthLogContext(req, { normalizedEmail: req.reporterPortal.email, sessionExists: true, verified: true }));
      }
      if (isReporterSubmissionsRequest(req)) {
        logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { normalizedEmail: req.reporterPortal.email, sessionExists: true, verified: true }));
      }
      return next();
    }

    const { token, authModel } = getReporterPortalTokenDetails(req);
    req.reporterPortalAuthModel = authModel;
    if (!token) {
      if (isReporterAuthCompatRequest(req) && isReporterSessionRequest(req)) {
        try {
          const pendingChallenge = await resolveCompatPendingChallenge(req);
          if (pendingChallenge.ok) {
            req.reporterPortalPendingChallenge = pendingChallenge.pending;
            return next();
          }
          if (pendingChallenge.reason && pendingChallenge.reason !== 'missing') {
            return respondReporterSessionExpired(req, res, `Pending reporter login challenge ${pendingChallenge.reason}`);
          }
        } catch (pendingError) {
          return respondReporterSessionExpired(req, res, pendingError?.message || 'Pending reporter login challenge missing');
        }
      }
      return respondReporterSessionMissing(req, res, 'No reporter token found in Authorization header or cookie');
    }

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'JWT_SECRET missing' });
    }

    payload = jwt.verify(token, secret);
    if (payload.type !== 'reporter_portal') {
      return respondReporterSessionMissing(req, res, 'Reporter token type invalid');
    }
    req.reporterPortalTokenPayload = payload;

    if (!isDbReady()) {
      const fallback = normalizeReporterPayload(payload);
      if (fallback.portalAccessEnabled === false) {
        return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
      }
      req.reporterPortal = fallback;
      if (isReporterSessionRequest(req)) {
        logReporterSession(buildReporterAuthLogContext(req, { verified: true }));
      }
      if (isReporterSubmissionsRequest(req)) {
        logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { verified: true }));
      }
      return next();
    }

    const reporterId = payload.reporterId || payload.sub;
    let reporter = null;
    if (reporterId && mongoose.isValidObjectId(String(reporterId))) {
      reporter = await ReporterContact.findById(reporterId);
    }
    if (!reporter && payload.email) {
      const email = normalizeEmail(payload.email);
      reporter = await ReporterContact.findOne({ $or: [{ email }, { emailLower: email }] });
    }

    if (!reporter) {
      const fallback = normalizeReporterPayload(payload);
      if (!fallback.email) {
        return respondReporterSessionMissing(req, res, 'Reporter profile lookup failed and token email was unavailable');
      }
      req.reporterPortal = fallback;
      req._reporterPortalDoc = null;
      if (isReporterSessionRequest(req)) {
        logReporterSession(buildReporterAuthLogContext(req, { normalizedEmail: fallback.email, verified: true }));
      }
      if (isReporterSubmissionsRequest(req)) {
        logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { normalizedEmail: fallback.email, verified: true }));
      }
      return next();
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
    }

    const tokenAuthVersion = typeof payload.portalAuthVersion === 'number' ? payload.portalAuthVersion : 0;
    const reporterAuthVersion = typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0;
    if (tokenAuthVersion !== reporterAuthVersion) {
      return respondReporterSessionMissing(req, res, 'Reporter token version no longer matches current reporter auth version');
    }

    req.reporterPortal = {
      reporterId: String(reporter._id),
      email: normalizeEmail(reporter.email || reporter.emailLower) || null,
      fullName: reporter.fullName || 'Reporter',
      reporterType: reporter.reporterType || 'community',
      verificationLevel: reporter.verificationLevel || 'community_default',
      portalAccessEnabled: reporter.portalAccessEnabled !== false,
      portalAuthVersion: reporterAuthVersion,
      status: reporter.status || 'active',
    };
    req._reporterPortalDoc = reporter;
    if (isReporterSessionRequest(req)) {
      logReporterSession(buildReporterAuthLogContext(req, { normalizedEmail: req.reporterPortal.email, verified: true }));
    }
    if (isReporterSubmissionsRequest(req)) {
      logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { normalizedEmail: req.reporterPortal.email, verified: true }));
    }
    return next();
  } catch (_error) {
    const fallback = normalizeReporterPayload(payload);
    if (fallback.email) {
      req.reporterPortalTokenPayload = payload;
      req.reporterPortal = fallback;
      req._reporterPortalDoc = null;
      if (isReporterSessionRequest(req)) {
        logReporterSession(buildReporterAuthLogContext(req, { normalizedEmail: fallback.email, verified: true }));
      }
      if (isReporterSubmissionsRequest(req)) {
        logReporterSubmissionsAuth(buildReporterAuthLogContext(req, { normalizedEmail: fallback.email, verified: true }));
      }
      return next();
    }
    return respondReporterSessionMissing(req, res, _error?.message || String(_error));
  }
}

module.exports = {
  getBearerToken,
  getReporterPortalCookieToken,
  getReporterPortalToken,
  REPORTER_PORTAL_COOKIE_NAME,
  requireReporterPortalAuth,
  requireReporterPortalOpen,
};