// middleware/adminAuth.js
// Shared admin/founder signed JWT authentication.
// Attaches req.admin on success.
// Responses:
// 401 -> missing/invalid token
// 403 -> present token but disallowed role
// Designed to align with other working admin endpoints expecting Authorization Bearer access tokens.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { rejectUnsafeCookieAuth } = require('../lib/authRequestSecurity');
const { requireModuleAccess } = require('./requireAuth');
const {
  effectiveAccountControlRights,
  effectivePermissions,
  effectiveSpecialRights,
  effectiveTaskRights,
  normalizeModuleAccess,
  normalizeRole,
} = require('../lib/teamAccess');
const {
  ACCOUNT_STATUS,
  accountLifecycleResponse,
  expireAccount,
  lifecycleStatus,
} = require('../lib/accountLifecycle');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    try { cookies[k] = decodeURIComponent(v.join('=') || ''); } catch (_) {}
  });
  return cookies;
}

async function requireAdminAuth(req, res, next) {
  return requireAdminJwt(req, res, next);
}

// Strict admin auth for session probes (e.g. GET /admin-api/admin/me).
// - Signed bearer/cookie token required (no legacy email cookies)
// - Missing/invalid/expired token => 401 JSON
// - Persisted accounts enforce lifecycle, token version and current role
async function requireAdminJwt(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '');
    const cookies = parseCookies(req.headers.cookie || '');
    const headerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    // Accept httpOnly cookie tokens for Vercel-proxied admin sessions.
    const cookieToken = cookies['np_admin_token'] || cookies['np_token'] || cookies['token'] || '';

    const token = headerToken || cookieToken;
    if (rejectUnsafeCookieAuth(req, res)) return;
    if (!token) return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });

    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) {
      // Should be prevented by startup checks, but keep response stable.
      return res.status(500).json({ ok: false, message: 'Server misconfigured' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
      if ((!payload.type && !payload.typ) || (payload.type && payload.type !== 'access') || (payload.typ && payload.typ !== 'access')) {
        return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
    } catch (_e) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    const role = payload && payload.role ? String(payload.role) : '';
    const normalizedRole = normalizeRole(role) || String(role).toLowerCase();
    if (!normalizedRole) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    // Keep this aligned with requireAdminAuth.
    if (normalizedRole !== 'legal' && !normalizeRole(normalizedRole)) {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }

    const userId = payload.sub || payload.userId || null;
    const email = payload.email || null;

    if (!isDbReady()) return res.status(503).json({ ok: false, code: 'AUTH_UNAVAILABLE', message: 'Authentication temporarily unavailable' });
    if (isDbReady()) {
      let user = null;
      if (userId && mongoose.isValidObjectId(String(userId))) {
        user = await User.findById(String(userId)).lean();
      }
      if (!userId && email) {
        user = await User.findOne({ email: String(email).toLowerCase() }).lean();
      }

      if (user) {
        const now = new Date();
        const resolvedStatus = lifecycleStatus(user, now);
        if (resolvedStatus !== ACCOUNT_STATUS.ACTIVE) {
          if (resolvedStatus === ACCOUNT_STATUS.EXPIRED) await expireAccount(User, user, { now });
          return accountLifecycleResponse(res, resolvedStatus);
        }
        const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
        if (user.loginAllowed === false) {
          return res.status(403).json({ ok: false, success: false, status: 403, code: 'LOGIN_DISABLED', message: 'Login disabled' });
        }

        const jwtTv = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
        const userTv = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
        if (jwtTv !== userTv) {
          return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
        }

        req._authUserDoc = user;
        req.admin = {
          id: String(user._id),
          email: user.email,
          staffId: user.staffId || null,
          role: normalizeRole(user.role) || user.role,
          name: user.name,
          permissions: effectivePermissions(user),
          moduleAccess: normalizeModuleAccess(user.moduleAccessOverride),
          specialRights: effectiveSpecialRights(user),
          taskRights: effectiveTaskRights(user),
          accountControlRights: effectiveAccountControlRights(user),
          status: user.status || 'active',
          accountStatus: user.accountStatus || accountStatus,
          accountExpiresAt: user.noExpiry === true ? null : (user.accessExpiresAt || null),
          accessExpiresAt: user.noExpiry === true ? null : (user.accessExpiresAt || null),
          noExpiry: Boolean(user.noExpiry || user.accessExpiresAt == null),
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

    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  } catch (_e) {
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

function requireAdminModule(moduleKey) {
  const authorize = requireModuleAccess(moduleKey);
  return (req, res, next) => requireAdminAuth(req, res, () => {
    req.user = req.admin;
    return authorize(req, res, next);
  });
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

module.exports = { requireAdminAuth, requireAdminJwt, requireAdminModule, requireFounderOnly, requireFounderAuth, requireFounderOrAdmin };
