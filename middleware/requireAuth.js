const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const { logAudit } = require('../lib/audit');
const {
  effectiveModuleAccess,
  effectivePermissions,
  effectiveSpecialRights,
  hasModuleAccess,
  hasSpecialRight,
  normalizeRole,
} = require('../lib/teamAccess');

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function loadUserFromPayload(payload) {
  const sub = payload && payload.sub ? String(payload.sub) : '';
  const email = payload && payload.email ? String(payload.email).toLowerCase() : '';

  if (sub && mongoose.isValidObjectId(sub)) {
    const byId = await User.findById(sub);
    if (byId) return byId;
  }

  if (email) {
    return User.findOne({ email });
  }

  return null;
}

function founderDenied(res) {
  return res.status(403).json({
    success: false,
    message: 'Access denied. Founder permission required.',
  });
}

function isSafeZoneMasterLocked() {
  const value = String(process.env.SAFE_ZONE_MASTER_LOCK || process.env.SAFE_ZONE_LOCKED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'locked'].includes(value);
}

async function loadRoleForUser(user) {
  if (!isDbReady() || !user || normalizeRole(user.role) === 'founder' || user.isFounder) return null;

  if (user.roleId && mongoose.isValidObjectId(String(user.roleId))) {
    const byId = await Role.findById(user.roleId).lean();
    if (byId) return byId;
  }

  const roleSlug = String(user.role || user.roleName || '').trim().toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-');
  if (!roleSlug) return null;
  return Role.findOne({ slug: roleSlug }).lean();
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, success: false, status: 500, code: 'SERVER_ERROR', message: 'JWT_SECRET missing' });
    }

    const payload = jwt.verify(token, secret);

    // If DB is down, fall back to payload-only auth (keeps dev/test from hard failing).
    if (!isDbReady()) {
      req.user = {
        id: payload.sub || payload.userId || null,
        email: payload.email || null,
        name: payload.name || null,
        role: normalizeRole(payload.role),
        tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0,
      };
      return next();
    }

    const user = await loadUserFromPayload(payload);
    if (!user) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
    const userStatus = String(user.status || accountStatus || 'active').toLowerCase();
    if (userStatus === 'suspended' || accountStatus === 'suspended') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' });
    }
    if (userStatus === 'locked' || accountStatus === 'locked') {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_LOCKED', message: 'Account locked' });
    }
    if (userStatus === 'expired' || accountStatus === 'expired' || (user.accessExpiresAt && user.accessExpiresAt <= new Date())) {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_EXPIRED', message: 'Account expired' });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'ACCOUNT_LOCKED', message: 'Account locked' });
    }

    const jwtTokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
    const userTokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;

    if (jwtTokenVersion !== userTokenVersion) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      name: user.fullName || user.name,
      fullName: user.fullName || user.name,
      role: normalizeRole(user.role) || 'intern',
      roleId: user.roleId ? String(user.roleId) : null,
      roleName: user.roleName || normalizeRole(user.role) || user.role || 'intern',
      designation: user.designation || null,
      permissions: effectivePermissions(user),
      moduleAccess: effectiveModuleAccess(user),
      specialRights: effectiveSpecialRights(user),
      moduleAccessOverride: Array.isArray(user.moduleAccessOverride) ? user.moduleAccessOverride : [],
      specialRightsOverride: Array.isArray(user.specialRightsOverride) ? user.specialRightsOverride : [],
      status: user.status || 'active',
      accountStatus: user.accountStatus || accountStatus,
      onlineStatus: user.onlineStatus || 'offline',
      mustChangePassword: Boolean(user.mustChangePassword || user.forceReset),
      tokenVersion: userTokenVersion,
      isFounder: Boolean(user.isFounder || normalizeRole(user.role) === 'founder'),
      isProtected: Boolean(user.isProtected || normalizeRole(user.role) === 'founder'),
    };

    req._authUserDoc = user;
    return next();
  } catch (_e) {
    return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

function requireFounder(req, res, next) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : '';
  if (role === 'founder') return next();
  return founderDenied(res);
}

function requireModuleAccess(moduleKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasModuleAccess(authUser, moduleKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { moduleKey, reason: 'module_denied' });
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    } catch (_e) {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }
  };
}

function requireSpecialRight(rightKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasSpecialRight(authUser, rightKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { rightKey, reason: 'right_denied' });
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    } catch (_e) {
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }
  };
}

module.exports = { requireAuth, requireFounder, requireModuleAccess, requireSpecialRight };
