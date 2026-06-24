// middleware/adminAuth.js
// Shared admin/founder JWT + legacy cookie auth.
// Attaches req.admin on success.
// Responses:
// 401 -> missing/invalid token & no legacy cookie
// 403 -> present token but disallowed role
// Designed to align with other working admin endpoints expecting Authorization Bearer access tokens.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { shouldLog } = require('../lib/logThrottle');
const {
  effectiveModuleAccess,
  effectivePermissions,
  effectiveSpecialRights,
  normalizeRole,
} = require('../lib/teamAccess');

const OFFICIAL_FOUNDER_EMAIL = 'kiran@newspulse.co.in';
const FOUNDER_RECOVERY_EMAIL = 'newspulse.team@gmail.com';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

function getFounderEmails() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const productionLike = env === 'production' || !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  return Array.from(new Set([
    OFFICIAL_FOUNDER_EMAIL,
    process.env.FOUNDER_EMAIL,
    process.env.ADMIN_EMAIL,
    process.env.FOUNDER_ALT_EMAIL,
    process.env.ADMIN_ALT_EMAIL,
    !productionLike ? 'founder@example.com' : null,
  ].map((value) => String(value || '').trim().toLowerCase()).filter((value) => value && value !== FOUNDER_RECOVERY_EMAIL)));
}

async function requireAdminAuth(req, res, next) {
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookies = parseCookies(req.headers.cookie || '');
  // Accept multiple legacy cookie keys for backward compatibility with older admin panel builds
  // Common variants observed in production/admin panel: np_admin, np_admin_email, np_admin_session
  const legacyEmail = cookies['np_admin'] || cookies['np_admin_email'] || cookies['np_admin_session'] || '';
  // Optional explicit access cookie (contains email value). Not considered privileged beyond email identification.
  const accessEmail = cookies['np_admin_access'] || '';
  // Some builds store an opaque admin token in a cookie; treat it like Bearer if present
  const cookieToken = cookies['np_admin_token'] || '';

  if (!token && !legacyEmail && !accessEmail && !cookieToken) {
    console.warn('[ADMIN_AUTH][401][missing]', {
      path: req.originalUrl,
      method: req.method,
      reason: 'no bearer token or recognized admin cookie',
      origin: req.headers.origin || null,
    });
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }

  const effectiveToken = token || cookieToken;
  if (effectiveToken) {
    try {
      // Accept opaque admin tokens issued by /admin-auth/login (prefix np.)
      if (effectiveToken.startsWith('np.')) {
        const decoded = decodeNpOpaqueToken(effectiveToken);
        const email = decoded && decoded.email ? decoded.email : 'admin@newspulse.ai';
        const founderEmails = getFounderEmails();
        const role = founderEmails.includes(String(email).toLowerCase()) ? 'founder' : 'admin';
        req.admin = { id: 'opaque', email, role, name: role === 'founder' ? 'Founder' : 'Admin' };
        return next();
      }
      const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
      const payload = jwt.verify(effectiveToken, secret);
      const role = normalizeRole(payload && payload.role ? payload.role : '') || String(payload && payload.role ? payload.role : '').toLowerCase();
      if (!role || (role === 'legal' ? false : !normalizeRole(role))) {
        console.warn('[ADMIN_AUTH][403][role] disallowed role', {
          path: req.originalUrl,
          method: req.method,
          role,
        });
        return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
      }
      // If DB is ready and token is tied to a user, enforce account status + tokenVersion
      // and enrich req.admin with persisted permissions/status fields.
      if (isDbReady()) {
        const sub = payload && payload.sub ? String(payload.sub) : '';
        const email = payload && payload.email ? String(payload.email).toLowerCase() : '';
        let user = null;
        if (sub && mongoose.isValidObjectId(sub)) {
          user = await User.findById(sub).lean();
        }
        if (!user && email) {
          user = await User.findOne({ email }).lean();
        }

        if (user) {
          const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
          const userStatus = String(user.status || accountStatus || 'active').toLowerCase();
          if (userStatus === 'suspended' || accountStatus === 'suspended') {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' });
          }
          if (user.loginAllowed === false) {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'LOGIN_DISABLED', message: 'Login disabled' });
          }
          if (userStatus === 'archived' || accountStatus === 'archived') {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_ARCHIVED', message: 'Account archived' });
          }
          if (userStatus === 'deleted' || userStatus === 'deleted_test' || accountStatus === 'deleted' || accountStatus === 'deleted_test' || user.isDeleted || user.deletedAt) {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_DELETED', message: 'Account deleted' });
          }
          if (userStatus === 'locked' || accountStatus === 'locked' || (user.lockedUntil && user.lockedUntil > new Date())) {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_LOCKED', message: 'Account locked' });
          }
          if (userStatus === 'expired' || accountStatus === 'expired' || (user.accessExpiresAt && user.accessExpiresAt <= new Date())) {
            return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_EXPIRED', message: 'Account expired' });
          }
          const jwtTv = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
          const userTv = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
          if (jwtTv !== userTv) {
            return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
          }

          req.admin = {
            id: payload.sub,
            email: payload.email,
            role,
            name: payload.name,
            moduleAccess: effectiveModuleAccess(user),
            permissions: effectivePermissions(user),
            specialRights: effectiveSpecialRights(user),
            status: user.status || 'active',
            accountStatus: user.accountStatus || accountStatus,
            onlineStatus: user.onlineStatus || 'offline',
            tokenVersion: userTv,
            lastLoginAt: user.lastLoginAt || null,
            mustChangePassword: Boolean(user.mustChangePassword || user.forceReset),
            isFounder: Boolean(user.isFounder || normalizeRole(user.role) === 'founder'),
            isProtected: Boolean(user.isProtected || normalizeRole(user.role) === 'founder'),
          };
          return next();
        }
      }

      req.admin = { id: payload.sub, email: payload.email, role, name: payload.name };
      return next();
    } catch (e) {
      if (e && e.message === 'jwt expired') {
        // Throttle noisy expired token logs (once per 60s per route key)
        const key = `adminAuth.expired:${req.method}:${req.originalUrl.split('?')[0]}`;
        if (shouldLog(key, 60_000)) {
          console.info('[ADMIN_AUTH][token] expired', {
            path: req.originalUrl,
            method: req.method,
            reason: 'access token expired',
          });
        }
      } else {
        console.warn('[ADMIN_AUTH][token-verify-failed]', {
          path: req.originalUrl,
          method: req.method,
          message: e?.message,
        });
      }
      if (!legacyEmail) {
        // Provide a machine-readable code to help clients trigger refresh.
        return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
    }
  }

  if (legacyEmail || accessEmail) {
    const emailValRaw = (legacyEmail || accessEmail);
    const emailVal = String(emailValRaw || '').toLowerCase();
    const founderEmails = getFounderEmails();
    const isFounder = founderEmails.includes(emailVal);
    req.admin = {
      id: isFounder ? 'founder' : 'legacy-admin',
      email: emailValRaw,
      role: isFounder ? 'founder' : 'admin',
      name: isFounder ? 'Founder' : 'Admin',
    };
    return next();
  }

  console.warn('[ADMIN_AUTH][401][fallback]', {
    path: req.originalUrl,
    method: req.method,
    reason: 'no valid token or cookie after checks',
    origin: req.headers.origin || null,
  });
  return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
}

// Strict admin auth for session probes (e.g. GET /admin-api/admin/me).
// - Bearer token required (no legacy email cookies)
// - Missing/invalid/expired token => 401 JSON
// - If DB is connected, user must exist; otherwise treat as not logged in
async function requireAdminJwt(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '');
    const cookies = parseCookies(req.headers.cookie || '');
    const headerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    // Accept httpOnly cookie tokens for Vercel-proxied admin sessions.
    const cookieToken = cookies['np_admin_token'] || cookies['np_token'] || cookies['token'] || '';

    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ ok: false, message: 'Unauthorized' });

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
      // Should be prevented by startup checks, but keep response stable.
      return res.status(500).json({ ok: false, message: 'Server misconfigured' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (_e) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const role = payload && payload.role ? String(payload.role) : '';
    const normalizedRole = normalizeRole(role) || String(role).toLowerCase();
    if (!normalizedRole) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    // Keep this aligned with requireAdminAuth.
    if (normalizedRole !== 'legal' && !normalizeRole(normalizedRole)) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const userId = payload.sub || payload.userId || null;
    const email = payload.email || null;

    // If DB is ready, enrich from a user record when available.
    // Do NOT require a DB record for env-based admin login flows.
    if (isDbReady()) {
      let user = null;
      if (userId && mongoose.isValidObjectId(String(userId))) {
        user = await User.findById(String(userId)).lean();
      }
      if (!user && email) {
        user = await User.findOne({ email: String(email).toLowerCase() }).lean();
      }

      if (user) {
        const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
        const userStatus = String(user.status || accountStatus || 'active').toLowerCase();
        if (userStatus === 'suspended' || userStatus === 'locked' || userStatus === 'expired' || userStatus === 'archived' || userStatus === 'deleted' || userStatus === 'deleted_test' || accountStatus === 'suspended' || accountStatus === 'locked' || accountStatus === 'expired' || accountStatus === 'archived' || accountStatus === 'deleted' || accountStatus === 'deleted_test' || user.isDeleted || user.deletedAt) {
          return res.status(403).json({ ok: false, message: 'Forbidden' });
        }
        if (user.loginAllowed === false) {
          return res.status(403).json({ ok: false, message: 'Forbidden' });
        }
        if ((user.lockedUntil && user.lockedUntil > new Date()) || (user.accessExpiresAt && user.accessExpiresAt <= new Date())) {
          return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const jwtTv = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
        const userTv = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
        if (jwtTv !== userTv) {
          return res.status(401).json({ ok: false, message: 'Unauthorized' });
        }

        req.admin = {
          id: String(user._id),
          email: user.email,
          role: normalizeRole(user.role) || user.role,
          name: user.name,
          permissions: effectivePermissions(user),
          status: user.status || 'active',
          accountStatus: user.accountStatus || accountStatus,
          onlineStatus: user.onlineStatus || 'offline',
          tokenVersion: userTv,
          isFounder: Boolean(user.isFounder || normalizeRole(user.role) === 'founder'),
          isProtected: Boolean(user.isProtected || normalizeRole(user.role) === 'founder'),
        };
        return next();
      }
    }

    // DB not ready: fall back to token-only identity.
    req.admin = {
      id: userId ? String(userId) : 'unknown',
      email: email ? String(email) : '',
      role: normalizedRole,
      name: payload.name ? String(payload.name) : undefined,
    };
    return next();
  } catch (_e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
}

function decodeNpOpaqueToken(tok) {
  // Token format: np.<base64(email:timestamp)>
  try {
    const raw = String(tok || '');
    if (!raw.startsWith('np.')) return null;
    const b64 = raw.slice('np.'.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const [email] = decoded.split(':');
    const cleaned = String(email || '').trim();
    return cleaned ? { email: cleaned } : null;
  } catch (_) {
    return null;
  }
}

function requireFounderOnly(req, res, next) {
  // First ensure admin auth passes
  requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return; // express error path
    const role = String((req.admin && req.admin.role) || '').toLowerCase();
    if (role !== 'founder') {
      return res.status(403).json({
        ok: false,
        success: false,
        status: 403,
        code: 'FOUNDER_REQUIRED',
        message: 'Founder role required',
        requiredRole: 'founder',
        receivedRole: role || null,
      });
    }
    return next();
  });
}
// Alias for clarity with routing instructions
const requireFounderAuth = requireFounderOnly;

// Admin/founder-only guard.
// - Uses requireAdminAuth for JWT/cookie parsing
// - Then restricts role to founder|admin only (excludes staff/editor/legal)
function requireFounderOrAdmin(req, res, next) {
  requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return;
    const role = String((req.admin && req.admin.role) || '').toLowerCase();
    if (role !== 'founder' && role !== 'admin') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }
    return next();
  });
}

module.exports = { requireAdminAuth, requireAdminJwt, requireFounderOnly, requireFounderAuth, requireFounderOrAdmin };
