const express = require('express');
const mongoose = require('mongoose');

const Role = require('../models/Role');
const { requireAuth } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const {
  ADMIN_MODULE_KEYS,
  effectiveSpecialRights,
  normalizeRole,
} = require('../lib/teamAccess');
const {
  CANONICAL_ADMIN_MODULE_KEYS,
  evaluateAllModuleAccess,
  evaluateModuleAccess,
  getFounderModulePolicy,
} = require('../services/founderAccessPolicyService');

const router = express.Router();

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isSafeZoneMasterLocked() {
  const value = String(process.env.SAFE_ZONE_MASTER_LOCK || process.env.SAFE_ZONE_LOCKED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'locked'].includes(value);
}

function roleSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-');
}

async function loadRoleForUser(req) {
  const user = req._authUserDoc || req.user;
  if (!isDbReady() || !user || user.isFounder || normalizeRole(user.role) === 'founder') return null;
  if (user.roleId && mongoose.isValidObjectId(String(user.roleId))) {
    const byId = await Role.findById(user.roleId).lean();
    if (byId) return byId;
  }
  const slug = roleSlug(user.role || user.roleName);
  if (!slug) return null;
  return Role.findOne({ slug }).lean();
}

router.use(requireAuth);

function buildIdentity(user) {
  return {
    id: user?.id || (user?._id ? String(user._id) : null),
    email: user?.email || null,
    name: user?.fullName || user?.name || null,
    role: normalizeRole(user?.role) || user?.role || null,
    position: user?.position || user?.designation || null,
    staffId: user?.staffId || null,
  };
}

function buildSpecialRightsSummary(user) {
  return {
    specialRights: Array.isArray(user?.specialRightsOverride) ? user.specialRightsOverride : [],
    taskRights: Array.isArray(user?.taskRightsOverride) ? user.taskRightsOverride : [],
    accountControlRights: Array.isArray(user?.accountControlRightsOverride) ? user.accountControlRightsOverride : [],
  };
}

async function myAccessPayload(req) {
  const user = req._authUserDoc || req.user;
  const policy = await getFounderModulePolicy({ defaultWhenDbUnavailable: true });
  const effectiveModuleAccess = evaluateAllModuleAccess(user, policy);
  const allowedModules = CANONICAL_ADMIN_MODULE_KEYS.filter((key) => effectiveModuleAccess[key]?.allowed);

  return {
    identity: buildIdentity(user),
    role: normalizeRole(user?.role) || user?.role || null,
    position: user?.position || user?.designation || null,
    staffId: user?.staffId || null,
    accountStatus: user?.accountStatus || user?.status || 'active',
    accountExpiry: user?.accessExpiresAt || null,
    accessVersion: typeof user?.accessVersion === 'number' ? user.accessVersion : 0,
    effectiveModuleAccess,
    modules: allowedModules,
    specialRights: buildSpecialRightsSummary(user),
  };
}

router.get('/me', async (req, res) => {
  const data = await myAccessPayload(req);
  return ok(res, { data, access: data });
});

router.get('/my-modules', async (req, res) => {
  const roleDoc = await loadRoleForUser(req);
  const user = req._authUserDoc || req.user;
  const access = await myAccessPayload(req);
  return ok(res, {
    data: {
      modules: access.modules,
      specialRights: effectiveSpecialRights(user, roleDoc),
      safeZoneMasterLocked: isSafeZoneMasterLocked(),
      effectiveModuleAccess: access.effectiveModuleAccess,
      accessVersion: access.accessVersion,
    },
    modules: access.modules,
    specialRights: effectiveSpecialRights(user, roleDoc),
    safeZoneMasterLocked: isSafeZoneMasterLocked(),
    effectiveModuleAccess: access.effectiveModuleAccess,
    accessVersion: access.accessVersion,
  });
});

router.get('/can-access/:moduleKey', async (req, res) => {
  const moduleKey = String(req.params.moduleKey || '').trim();
  if (!ADMIN_MODULE_KEYS.includes(moduleKey)) {
    await logAudit(req, 'ACCESS_BLOCKED', req.user?.id || null, { moduleKey, reason: 'unknown_module' });
    return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
  }

  const user = req._authUserDoc || req.user;
  const policy = await getFounderModulePolicy({ defaultWhenDbUnavailable: true });
  const decision = evaluateModuleAccess(user, moduleKey, policy);
  const allowed = decision.canonicalKey ? decision.allowed : false;
  if (!allowed) await logAudit(req, 'ACCESS_BLOCKED', req.user?.id || null, { moduleKey, reason: decision.reasonCode || 'module_denied' });
  return ok(res, { data: { moduleKey, allowed, decision }, moduleKey, allowed, decision });
});

router.myAccessPayload = myAccessPayload;

module.exports = router;