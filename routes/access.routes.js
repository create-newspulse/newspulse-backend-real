const express = require('express');
const mongoose = require('mongoose');

const Role = require('../models/Role');
const { requireAuth } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const {
  ADMIN_MODULE_KEYS,
  effectiveModuleAccess,
  effectiveSpecialRights,
  hasModuleAccess,
  normalizeRole,
} = require('../lib/teamAccess');

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

router.get('/my-modules', async (req, res) => {
  const roleDoc = await loadRoleForUser(req);
  const user = req._authUserDoc || req.user;
  return ok(res, {
    data: {
      modules: effectiveModuleAccess(user, roleDoc),
      specialRights: effectiveSpecialRights(user, roleDoc),
      safeZoneMasterLocked: isSafeZoneMasterLocked(),
    },
    modules: effectiveModuleAccess(user, roleDoc),
    specialRights: effectiveSpecialRights(user, roleDoc),
    safeZoneMasterLocked: isSafeZoneMasterLocked(),
  });
});

router.get('/can-access/:moduleKey', async (req, res) => {
  const moduleKey = String(req.params.moduleKey || '').trim();
  if (!ADMIN_MODULE_KEYS.includes(moduleKey)) {
    await logAudit(req, 'ACCESS_BLOCKED', req.user?.id || null, { moduleKey, reason: 'unknown_module' });
    return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
  }

  const roleDoc = await loadRoleForUser(req);
  const user = req._authUserDoc || req.user;
  const allowed = hasModuleAccess(user, moduleKey, roleDoc, isSafeZoneMasterLocked());
  if (!allowed) await logAudit(req, 'ACCESS_BLOCKED', req.user?.id || null, { moduleKey, reason: 'module_denied' });
  return ok(res, { data: { moduleKey, allowed }, moduleKey, allowed });
});

module.exports = router;