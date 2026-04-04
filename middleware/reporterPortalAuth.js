const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const ReporterContact = require('../models/ReporterContact');
const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
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
    email: payload && payload.email ? String(payload.email).trim().toLowerCase() : null,
    fullName: payload && payload.fullName ? String(payload.fullName) : 'Reporter',
    reporterType: payload && payload.reporterType ? String(payload.reporterType) : 'community',
    verificationLevel: payload && payload.verificationLevel ? String(payload.verificationLevel) : 'community_default',
    portalAccessEnabled: payload && typeof payload.portalAccessEnabled === 'boolean' ? payload.portalAccessEnabled : true,
    portalAuthVersion: payload && typeof payload.portalAuthVersion === 'number' ? payload.portalAuthVersion : 0,
    status: payload && payload.status ? String(payload.status) : 'active',
  };
}

async function requireReporterPortalAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, code: 'REPORTER_AUTH_REQUIRED', message: 'Reporter authentication required.' });
    }

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'JWT_SECRET missing' });
    }

    const payload = jwt.verify(token, secret);
    if (payload.type !== 'reporter_portal') {
      return res.status(401).json({ ok: false, code: 'REPORTER_AUTH_REQUIRED', message: 'Reporter authentication required.' });
    }
    req.reporterPortalTokenPayload = payload;

    if (!isDbReady()) {
      const fallback = normalizeReporterPayload(payload);
      if (fallback.portalAccessEnabled === false) {
        return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
      }
      req.reporterPortal = fallback;
      return next();
    }

    const reporterId = payload.reporterId || payload.sub;
    let reporter = null;
    if (reporterId && mongoose.isValidObjectId(String(reporterId))) {
      reporter = await ReporterContact.findById(reporterId);
    }
    if (!reporter && payload.email) {
      const email = String(payload.email).trim().toLowerCase();
      reporter = await ReporterContact.findOne({ $or: [{ email }, { emailLower: email }] });
    }

    if (!reporter) {
      return res.status(401).json({ ok: false, code: 'REPORTER_AUTH_REQUIRED', message: 'Reporter authentication required.' });
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
    }

    const tokenAuthVersion = typeof payload.portalAuthVersion === 'number' ? payload.portalAuthVersion : 0;
    const reporterAuthVersion = typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0;
    if (tokenAuthVersion !== reporterAuthVersion) {
      return res.status(401).json({ ok: false, code: 'REPORTER_AUTH_REQUIRED', message: 'Reporter authentication required.' });
    }

    req.reporterPortal = {
      reporterId: String(reporter._id),
      email: String(reporter.email || reporter.emailLower || '').trim().toLowerCase(),
      fullName: reporter.fullName || 'Reporter',
      reporterType: reporter.reporterType || 'community',
      verificationLevel: reporter.verificationLevel || 'community_default',
      portalAccessEnabled: reporter.portalAccessEnabled !== false,
      portalAuthVersion: reporterAuthVersion,
      status: reporter.status || 'active',
    };
    req._reporterPortalDoc = reporter;
    return next();
  } catch (_error) {
    return res.status(401).json({ ok: false, code: 'REPORTER_AUTH_REQUIRED', message: 'Reporter authentication required.' });
  }
}

module.exports = {
  getBearerToken,
  requireReporterPortalAuth,
  requireReporterPortalOpen,
};