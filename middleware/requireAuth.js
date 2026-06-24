const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const { logAudit } = require('../lib/audit');
const {
  effectiveModuleAccess,
  effectiveAccountControlRights,
  effectivePermissions,
  effectiveSpecialRights,
  effectiveTaskRights,
  hasAccountControlRight,
  hasModuleAccess,
  hasSpecialRight,
  hasTaskRight,
  isProtectedFounderUser,
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

function sessionExpired(res) {
  return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Session expired. Please login again.' });
}

function moduleDenied(res) {
  return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Access Denied. Founder permission is required.' });
}

function actionDenied(res) {
  return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Action denied. Founder permission is required.' });
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
      return sessionExpired(res);
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
      return sessionExpired(res);
    }

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
      return sessionExpired(res);
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      staffId: user.staffId || null,
      name: user.fullName || user.name,
      fullName: user.fullName || user.name,
      role: normalizeRole(user.role) || 'intern',
      roleId: user.roleId ? String(user.roleId) : null,
      roleName: user.roleName || normalizeRole(user.role) || user.role || 'intern',
      designation: user.designation || null,
      permissions: effectivePermissions(user),
      moduleAccess: effectiveModuleAccess(user),
      specialRights: effectiveSpecialRights(user),
      taskRights: effectiveTaskRights(user),
      accountControlRights: effectiveAccountControlRights(user),
      moduleAccessOverride: Array.isArray(user.moduleAccessOverride) ? user.moduleAccessOverride : [],
      specialRightsOverride: Array.isArray(user.specialRightsOverride) ? user.specialRightsOverride : [],
      taskRightsOverride: Array.isArray(user.taskRightsOverride) ? user.taskRightsOverride : [],
      accountControlRightsOverride: Array.isArray(user.accountControlRightsOverride) ? user.accountControlRightsOverride : [],
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
    return sessionExpired(res);
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
      if (!req.user) return sessionExpired(res);
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasModuleAccess(authUser, moduleKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { module: moduleKey, moduleKey, reason: 'module_denied', result: 'blocked', severity: 'warning', targetType: 'module', targetId: moduleKey });
      return moduleDenied(res);
    } catch (_e) {
      return moduleDenied(res);
    }
  };
}

function requireSpecialRight(rightKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return sessionExpired(res);
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasSpecialRight(authUser, rightKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { rightKey, reason: 'right_denied', result: 'blocked', severity: 'warning', targetType: 'special_right', targetId: rightKey });
      return actionDenied(res);
    } catch (_e) {
      return actionDenied(res);
    }
  };
}

function requireTaskRight(taskRightKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return sessionExpired(res);
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasTaskRight(authUser, taskRightKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { rightKey: taskRightKey, reason: 'task_right_denied', result: 'blocked', severity: 'warning', targetType: 'task_right', targetId: taskRightKey });
      return actionDenied(res);
    } catch (_e) {
      return actionDenied(res);
    }
  };
}

function requireAccountControlRight(accountRightKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return sessionExpired(res);
      if (req.user.isFounder || normalizeRole(req.user.role) === 'founder') return next();

      const authUser = req._authUserDoc || req.user;
      const roleDoc = await loadRoleForUser(authUser);
      if (hasAccountControlRight(authUser, accountRightKey, roleDoc, isSafeZoneMasterLocked())) return next();

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { rightKey: accountRightKey, reason: 'account_control_right_denied', result: 'blocked', severity: 'warning', targetType: 'account_control_right', targetId: accountRightKey });
      return actionDenied(res);
    } catch (_e) {
      return actionDenied(res);
    }
  };
}

function blockFounderAccountMutation(req, res, next) {
  const target = req.targetUser || req.staffUser || req.userTarget || null;
  const targetStaffId = String(target?.staffId || req.body?.staffId || req.params?.staffId || '').trim().toUpperCase();
  if (!target && !targetStaffId) return next();
  if (!isProtectedFounderUser(target) && targetStaffId !== 'NP-FND-0001') return next();
  return logAudit(req, 'BLOCKED_FOUNDER_ACCOUNT_MUTATION_ATTEMPT', target?._id ? String(target._id) : null, { result: 'blocked', severity: 'critical', targetStaffId, reason: 'founder_account_protected' })
    .finally(() => actionDenied(res));
}

function auditAction(action, metaBuilder = null) {
  return async (req, _res, next) => {
    try {
      const meta = typeof metaBuilder === 'function' ? metaBuilder(req) : metaBuilder;
      await logAudit(req, action, req.params?.id || null, meta || null);
    } catch (_) {}
    return next();
  };
}

module.exports = {
  requireAuth,
  requireFounder,
  requireModuleAccess,
  requireSpecialRight,
  requireTaskRight,
  requireAccountControlRight,
  blockFounderAccountMutation,
  auditAction,
};
