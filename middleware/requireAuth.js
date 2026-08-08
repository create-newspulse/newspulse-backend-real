const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { performance } = require('perf_hooks');
const User = require('../models/User');
const Role = require('../models/Role');
const { logAudit } = require('../lib/audit');
const {
  effectiveAccountControlRights,
  effectivePermissions,
  effectiveSpecialRights,
  effectiveTaskRights,
  hasAccountControlRight,
  hasModuleAccess,
  hasSpecialRight,
  hasTaskRight,
  isProtectedFounderUser,
  normalizeModuleAccess,
  normalizeRole,
} = require('../lib/teamAccess');
const {
  evaluateModuleAccess,
  getFounderModulePolicy,
} = require('../services/founderAccessPolicyService');
const {
  ACCOUNT_STATUS,
  accountLifecycleResponse,
  expireAccount,
  lifecycleStatus,
} = require('../lib/accountLifecycle');

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((entry) => {
    const [key, ...value] = entry.trim().split('=');
    if (!key) return;
    cookies[key] = decodeURIComponent(value.join('=') || '');
  });
  return cookies;
}

function getAuthToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  const cookies = req.cookies && typeof req.cookies === 'object' ? req.cookies : parseCookies(req.headers.cookie || '');
  for (const name of ['token', 'np_token', 'np_admin_token']) {
    const token = String(cookies[name] || '').trim();
    if (token) return token;
  }
  return null;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isMeTimingEnabled(req) {
  const flag = String(process.env.ME_TIMING || process.env.DEBUG_ME_TIMING || '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(flag)) return false;
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  const pathName = String(req.originalUrl || req.url || '').split('?')[0];
  return req.method === 'GET' && (pathName === '/me' || pathName.endsWith('/me'));
}

function isCurrentUserProbe(req) {
  const pathName = String(req?.originalUrl || req?.url || '').split('?')[0];
  return req?.method === 'GET' && (pathName === '/me' || pathName.endsWith('/me'));
}

function roundTiming(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function ensureMeTiming(req) {
  if (!req || !isMeTimingEnabled(req)) return null;
  if (!req._meTiming) {
    req._meTiming = {
      start: performance.now(),
      steps: [],
      dbQueries: { user: 0, role: 0, policy: 0 },
    };
  }
  return req._meTiming;
}

function recordMeTiming(req, label, startedAt, extra = {}) {
  const timing = ensureMeTiming(req);
  if (!timing) return;
  timing.steps.push({ label, ms: roundTiming(performance.now() - startedAt), ...extra });
}

function timeMeStep(req, label, fn, extra = {}) {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    recordMeTiming(req, label, startedAt, extra);
  }
}

async function timeMeStepAsync(req, label, fn, extra = {}) {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    recordMeTiming(req, label, startedAt, extra);
  }
}

function countMeQuery(req, key) {
  const timing = ensureMeTiming(req);
  if (!timing) return;
  timing.dbQueries[key] = (timing.dbQueries[key] || 0) + 1;
}

function finishMeTiming(req, res, extra = {}) {
  const timing = req?._meTiming;
  if (!timing) return;
  const totalMs = roundTiming(performance.now() - timing.start);
  const slowest = timing.steps.reduce((max, step) => (step.ms > (max?.ms || -1) ? step : max), null);
  const role = req.user?.role || req.admin?.role || null;
  console.info('[me-timing]', {
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    status: res?.statusCode || extra.status || null,
    role,
    isFounder: Boolean(req.user?.isFounder || req.admin?.isFounder || String(role || '').toLowerCase() === 'founder'),
    totalMs,
    slowest: slowest ? { label: slowest.label, ms: slowest.ms } : null,
    dbQueries: timing.dbQueries,
    steps: timing.steps,
    ...extra,
  });
}

async function loadUserFromPayload(payload, req = null) {
  const sub = payload && payload.sub ? String(payload.sub) : '';
  const email = payload && payload.email ? String(payload.email).toLowerCase() : '';

  if (sub && mongoose.isValidObjectId(sub)) {
    countMeQuery(req, 'user');
    const byId = await User.findById(sub);
    if (byId) return byId;
  }

  if (email) {
    countMeQuery(req, 'user');
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
    ensureMeTiming(req);
    const token = timeMeStep(req, 'auth.token_read', () => getAuthToken(req));
    if (!token) {
      finishMeTiming(req, res, { status: 401, result: 'no_session' });
      return sessionExpired(res);
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      finishMeTiming(req, res, { status: 500, result: 'missing_secret' });
      return res.status(500).json({ ok: false, success: false, status: 500, code: 'SERVER_ERROR', message: 'JWT_SECRET missing' });
    }

    const payload = timeMeStep(req, 'auth.jwt_verify', () => jwt.verify(token, secret));

    // If DB is down, fall back to payload-only auth (keeps dev/test from hard failing).
    if (!isDbReady()) {
      req.user = timeMeStep(req, 'auth.payload_identity', () => ({
        id: payload.sub || payload.userId || null,
        email: payload.email || null,
        name: payload.name || null,
        role: normalizeRole(payload.role) || String(payload.role || 'intern').toLowerCase(),
        tokenVersion: typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0,
        isFounder: (normalizeRole(payload.role) || String(payload.role || '').toLowerCase()) === 'founder',
        isProtected: (normalizeRole(payload.role) || String(payload.role || '').toLowerCase()) === 'founder',
      }));
      return next();
    }

    const user = await timeMeStepAsync(req, 'auth.user_lookup', () => loadUserFromPayload(payload, req));
    if (!user) {
      finishMeTiming(req, res, { status: 401, result: 'user_not_found' });
      return sessionExpired(res);
    }

    const now = new Date();
    const resolvedStatus = timeMeStep(req, 'auth.lifecycle_check', () => lifecycleStatus(user, now));
    if (resolvedStatus !== ACCOUNT_STATUS.ACTIVE) {
      if (resolvedStatus === ACCOUNT_STATUS.EXPIRED) await expireAccount(User, user, { now });
      finishMeTiming(req, res, { status: 403, result: resolvedStatus });
      return accountLifecycleResponse(res, resolvedStatus);
    }
    const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
    if (user.loginAllowed === false) {
      finishMeTiming(req, res, { status: 403, result: 'login_disabled' });
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'LOGIN_DISABLED', message: 'Login disabled' });
    }

    const jwtTokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
    const userTokenVersion = typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;

    if (jwtTokenVersion !== userTokenVersion) {
      finishMeTiming(req, res, { status: 401, result: 'token_version_mismatch' });
      return sessionExpired(res);
    }

    const role = timeMeStep(req, 'auth.founder_detection', () => normalizeRole(user.role) || String(user.role || 'intern').toLowerCase());
    const isFounder = Boolean(user.isFounder || role === 'founder');

    const permissionFields = timeMeStep(req, 'auth.permission_projection', () => {
      if (isCurrentUserProbe(req)) {
        return {
          permissions: [],
          moduleAccess: normalizeModuleAccess(user.moduleAccessOverride),
          specialRights: Array.isArray(user.specialRightsOverride) ? user.specialRightsOverride : [],
          taskRights: Array.isArray(user.taskRightsOverride) ? user.taskRightsOverride : [],
          accountControlRights: Array.isArray(user.accountControlRightsOverride) ? user.accountControlRightsOverride : [],
        };
      }

      return {
        permissions: effectivePermissions(user),
        moduleAccess: normalizeModuleAccess(user.moduleAccessOverride),
        specialRights: effectiveSpecialRights(user),
        taskRights: effectiveTaskRights(user),
        accountControlRights: effectiveAccountControlRights(user),
      };
    });

    req.user = {
      id: String(user._id),
      email: user.email,
      staffId: user.staffId || null,
      name: user.fullName || user.name,
      fullName: user.fullName || user.name,
      role,
      roleId: user.roleId ? String(user.roleId) : null,
      roleName: user.roleName || role || user.role || 'intern',
      position: user.position || user.officialTitle || user.designation || null,
      designation: user.designation || null,
      permissions: permissionFields.permissions,
      moduleAccess: permissionFields.moduleAccess,
      specialRights: permissionFields.specialRights,
      taskRights: permissionFields.taskRights,
      accountControlRights: permissionFields.accountControlRights,
      moduleAccessOverride: Array.isArray(user.moduleAccessOverride) ? user.moduleAccessOverride : [],
      specialRightsOverride: Array.isArray(user.specialRightsOverride) ? user.specialRightsOverride : [],
      taskRightsOverride: Array.isArray(user.taskRightsOverride) ? user.taskRightsOverride : [],
      accountControlRightsOverride: Array.isArray(user.accountControlRightsOverride) ? user.accountControlRightsOverride : [],
      status: user.status || 'active',
      accountStatus: user.accountStatus || accountStatus,
      accountExpiresAt: user.noExpiry === true ? null : (user.accessExpiresAt || null),
      accessExpiresAt: user.noExpiry === true ? null : (user.accessExpiresAt || null),
      noExpiry: Boolean(user.noExpiry || user.accessExpiresAt == null),
      onlineStatus: user.onlineStatus || 'offline',
      mustChangePassword: Boolean(user.mustChangePassword || user.forceReset),
      tokenVersion: userTokenVersion,
      accessVersion: typeof user.accessVersion === 'number' ? user.accessVersion : 0,
      isFounder,
      isProtected: Boolean(user.isProtected || isFounder),
    };

    req._authUserDoc = user;
    return next();
  } catch (_e) {
    finishMeTiming(req, res, { status: 401, result: 'auth_exception' });
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
      const policy = await getFounderModulePolicy({ defaultWhenDbUnavailable: true });
      const decision = evaluateModuleAccess(authUser, moduleKey, policy);
      if (decision.canonicalKey) {
        if (decision.allowed) return next();

        await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { module: moduleKey, moduleKey, reason: decision.reasonCode, result: 'blocked', severity: 'warning', targetType: 'module', targetId: moduleKey, globalState: decision.globalState, individualState: decision.individualState });
        return moduleDenied(res);
      }

      await logAudit(req, 'ACCESS_BLOCKED', req.user.id || null, { module: moduleKey, moduleKey, reason: 'unknown_module', result: 'blocked', severity: 'warning', targetType: 'module', targetId: moduleKey });
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
  finishMeTiming,
  timeMeStep,
  timeMeStepAsync,
  countMeQuery,
  requireFounder,
  requireModuleAccess,
  requireSpecialRight,
  requireTaskRight,
  requireAccountControlRight,
  blockFounderAccountMutation,
  auditAction,
};
