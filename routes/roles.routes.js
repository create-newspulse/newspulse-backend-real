const express = require('express');
const mongoose = require('mongoose');

const Role = require('../models/Role');
const User = require('../models/User');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { logAudit } = require('../lib/audit');
const {
  ACCOUNT_CONTROL_RIGHT_KEYS,
  ADMIN_MODULE_KEYS,
  FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS,
  FOUNDER_ONLY_RIGHTS,
  SPECIAL_RIGHT_KEYS,
  SYSTEM_ROLE_DEFINITIONS,
  TASK_RIGHT_KEYS,
  normalizeModuleAccess,
  normalizeSpecialRights,
  normalizeTaskRights,
} = require('../lib/teamAccess');
const {
  CANONICAL_TO_LEGACY_MODULE,
  canonicalModuleKey,
} = require('../services/founderAccessPolicyService');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function validationBad(res, error) {
  return res.status(error.status || 400).json({
    ok: false,
    success: false,
    status: error.status || 400,
    code: error.code,
    message: error.message,
    permissionKey: error.permissionKey || null,
    reason: error.reason || null,
  });
}

function roleTemplatePermissionError(permissionKey, reason, status = 400) {
  return {
    status,
    message: reason === 'unknown'
      ? 'Unknown permission cannot be included in a role template.'
      : 'This permission cannot be included in a role template.',
    code: reason === 'unknown' ? 'ROLE_TEMPLATE_UNKNOWN_PERMISSION' : 'ROLE_TEMPLATE_FORBIDDEN_PERMISSION',
    permissionKey,
    reason,
  };
}

function syncReqUserFromAdmin(req) {
  if (!req.admin) return;
  req.user = {
    id: req.admin.id || null,
    email: req.admin.email || null,
    name: req.admin.name || null,
    role: req.admin.role || null,
    permissions: Array.isArray(req.admin.permissions) ? req.admin.permissions : [],
    status: req.admin.status || 'active',
    isFounder: Boolean(req.admin.isFounder || String(req.admin.role || '').toLowerCase() === 'founder'),
  };
}

function hasAdminCredential(req) {
  const authHeader = String(req.headers.authorization || '');
  const cookieHeader = String(req.headers.cookie || '');
  return authHeader.toLowerCase().startsWith('bearer ')
    || /(?:^|;\s*)np_admin(?:=|_email=|_session=|_access=|_token=)/.test(cookieHeader);
}

function requireRoleAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) return requireAuth(req, res, next);
  if (!hasAdminCredential(req)) return bad(res, 401, 'Unauthorized. Please login again.', 'UNAUTHORIZED');

  return requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return next(err);
    syncReqUserFromAdmin(req);
    return next();
  });
}

function requireRoleFounder(req, res, next) {
  if (req.user?.isFounder || String(req.user?.role || '').toLowerCase() === 'founder') return next();
  return requireFounder(req, res, next);
}

function actorId(req) {
  return mongoose.isValidObjectId(req.user?.id) ? req.user.id : null;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/\s_-]+/g, '')
    .replace(/\s*\/\s*/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function roleDto(role) {
  if (!role) return null;
  const id = role._id ? String(role._id) : (role.id ? String(role.id) : null);
  return {
    ...(id ? { _id: id, id } : {}),
    name: role.name,
    slug: role.slug,
    description: role.description || '',
    sortOrder: typeof role.sortOrder === 'number' ? role.sortOrder : 100,
    isSystemRole: Boolean(role.isSystemRole),
    isProtected: Boolean(role.isProtected || role.slug === 'founder'),
    moduleAccess: normalizeModuleAccess(role.moduleAccess),
    specialRights: normalizeSpecialRights(role.specialRights),
    taskRights: normalizeTaskRights(role.taskRights),
    createdBy: role.createdBy || null,
    createdAt: role.createdAt || null,
    updatedAt: role.updatedAt || null,
  };
}

const ROLE_TEMPLATE_FORBIDDEN_MODULES = Object.freeze(new Set([
  'safe_zone',
  'team_management',
  'settings',
  'ai_engine',
  'audit_logs',
]));

const ROLE_TEMPLATE_FORBIDDEN_MODULE_ALIASES = Object.freeze(new Set([
  'safeZone',
  'founderAccessControl',
  'founderAccountControl',
  'emergencyFounderControls',
  'safe_zone',
  'team_management',
  'settings',
  'audit_logs',
]));

const ROLE_TEMPLATE_FORBIDDEN_RIGHTS = Object.freeze(new Set([
  ...FOUNDER_ONLY_RIGHTS,
  ...FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS,
  ...ACCOUNT_CONTROL_RIGHT_KEYS,
  'staff_create',
  'staff_edit',
  'staff_email_change',
  'role_create',
  'role_edit',
  'role_delete',
  'role_delete_system',
  'finance_approve_payment',
  'finance_delete_record',
  'finance_change_bank_details',
  'finance_change_payment_gateway',
  'finance_approve_withdrawal',
  'finance_final_report_approval',
  'finance_final_approval',
  'bank_payment_settings_change',
]));

const ROLE_TEMPLATE_FORBIDDEN_RIGHT_ALIASES = Object.freeze(new Set([
  'control_founder_account',
  'modify_founder_account',
  'grant_founder_role',
  'access_safe_zone',
  'manage_founder_access_control',
  'delete_founder',
  'suspend_founder',
  'demote_founder',
  'create_staff',
  'delete_staff_permanently',
  'change_bank_details',
  'change_payment_gateway',
  'approve_withdrawal',
  'payment_approval',
]));

function submittedKeys(value) {
  if (value === undefined) return { provided: false, keys: [] };
  if (Array.isArray(value)) return { provided: true, keys: value.map((item) => String(item || '').trim()).filter(Boolean) };
  if (value && typeof value === 'object') return { provided: true, keys: Object.keys(value).map((key) => String(key || '').trim()).filter(Boolean) };
  return { provided: true, keys: [String(value || '').trim()].filter(Boolean) };
}

function normalizeRoleTemplateModuleKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (ADMIN_MODULE_KEYS.includes(raw)) return raw;
  const canonical = canonicalModuleKey(raw, { allowLegacy: true });
  if (canonical === 'dashboard') return 'dashboard';
  if (canonical && CANONICAL_TO_LEGACY_MODULE[canonical] && ADMIN_MODULE_KEYS.includes(CANONICAL_TO_LEGACY_MODULE[canonical])) return CANONICAL_TO_LEGACY_MODULE[canonical];
  if (raw === 'staffTasks') return 'staff_tasks';
  return null;
}

function validateRoleTemplatePermissions(body) {
  const moduleInput = submittedKeys(body.moduleAccess);
  if (moduleInput.provided) {
    for (const key of moduleInput.keys) {
      if (ROLE_TEMPLATE_FORBIDDEN_MODULE_ALIASES.has(key)) return { error: roleTemplatePermissionError(key, 'forbidden') };
      const normalized = normalizeRoleTemplateModuleKey(key);
      if (!normalized) return { error: roleTemplatePermissionError(key, 'unknown') };
      if (ROLE_TEMPLATE_FORBIDDEN_MODULES.has(normalized)) return { error: roleTemplatePermissionError(key, 'forbidden') };
    }
  }

  for (const field of ['specialRights', 'taskRights']) {
    const input = submittedKeys(body[field]);
    if (!input.provided) continue;
    const allowed = field === 'taskRights' ? new Set(TASK_RIGHT_KEYS) : new Set(SPECIAL_RIGHT_KEYS);
    for (const key of input.keys) {
      if (ROLE_TEMPLATE_FORBIDDEN_RIGHT_ALIASES.has(key) || ROLE_TEMPLATE_FORBIDDEN_RIGHTS.has(key)) return { error: roleTemplatePermissionError(key, 'forbidden') };
      if (!allowed.has(key)) return { error: roleTemplatePermissionError(key, 'unknown') };
    }
  }

  return { ok: true };
}

function normalizeRoleTemplateModules(value) {
  if (value === undefined) return [];
  let keys = [];
  if (Array.isArray(value)) {
    keys = value.map((item) => String(item || '').trim()).filter(Boolean);
  } else if (value && typeof value === 'object') {
    keys = Object.entries(value)
      .filter(([, state]) => state === true || state === 1 || ['enabled', 'temporary', 'on', 'true', 'yes'].includes(String(state || '').trim().toLowerCase()))
      .map(([key]) => String(key || '').trim())
      .filter(Boolean);
  } else {
    keys = [String(value || '').trim()].filter(Boolean);
  }
  const normalized = keys.map(normalizeRoleTemplateModuleKey).filter(Boolean);
  return normalizeModuleAccess(normalized);
}

function inspectUnsafeRoleTemplate(role) {
  const unsafe = [];
  for (const key of submittedKeys(role?.moduleAccess).keys) {
    const normalized = normalizeRoleTemplateModuleKey(key);
    if (!normalized || ROLE_TEMPLATE_FORBIDDEN_MODULES.has(normalized) || ROLE_TEMPLATE_FORBIDDEN_MODULE_ALIASES.has(key)) unsafe.push({ field: 'moduleAccess', key, reason: normalized ? 'forbidden' : 'unknown' });
  }
  for (const [field, allowedList] of [['specialRights', SPECIAL_RIGHT_KEYS], ['taskRights', TASK_RIGHT_KEYS]]) {
    const allowed = new Set(allowedList);
    for (const key of submittedKeys(role?.[field]).keys) {
      if (ROLE_TEMPLATE_FORBIDDEN_RIGHT_ALIASES.has(key) || ROLE_TEMPLATE_FORBIDDEN_RIGHTS.has(key)) unsafe.push({ field, key, reason: 'forbidden' });
      else if (!allowed.has(key)) unsafe.push({ field, key, reason: 'unknown' });
    }
  }
  return unsafe;
}

async function ensureSystemRoles(req) {
  if (!isDbReady()) return;
  const createdBy = actorId(req);
  for (const role of SYSTEM_ROLE_DEFINITIONS) {
    const setOnInsert = {
      createdBy,
      updatedBy: createdBy,
      createdAt: new Date(),
    };
    await Role.updateOne(
      { slug: role.slug },
      {
        $setOnInsert: setOnInsert,
        $set: {
          name: role.name,
          description: role.description,
          sortOrder: role.sortOrder,
          isSystemRole: true,
          moduleAccess: role.moduleAccess.slice(),
          specialRights: role.specialRights.slice(),
          taskRights: role.taskRights ? role.taskRights.slice() : [],
          updatedAt: new Date(),
          ...(role.slug === 'founder' ? { isProtected: true } : {}),
        },
      },
      { upsert: true },
    );
  }
}

async function findRoleById(id, res) {
  if (!mongoose.isValidObjectId(String(id))) {
    bad(res, 400, 'Invalid id', 'INVALID_ID');
    return null;
  }
  const role = await Role.findById(String(id));
  if (!role) {
    bad(res, 404, 'Not found', 'NOT_FOUND');
    return null;
  }
  return role;
}

function parseRolePayload(body, existing) {
  const patch = {};

  if (!existing || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return { error: { status: 400, message: 'name is required', code: 'MISSING_NAME' } };
    patch.name = name;
  }

  if (!existing || body.slug !== undefined || body.name !== undefined) {
    const slug = slugify(body.slug || patch.name || existing?.name);
    if (!slug) return { error: { status: 400, message: 'slug is required', code: 'MISSING_SLUG' } };
    patch.slug = slug;
  }

  if (body.description !== undefined) patch.description = String(body.description || '').trim();
  if (body.sortOrder !== undefined) {
    const sortOrder = Number(body.sortOrder);
    if (!Number.isFinite(sortOrder)) return { error: { status: 400, message: 'Invalid sortOrder', code: 'INVALID_SORT_ORDER' } };
    patch.sortOrder = sortOrder;
  }
  if (body.moduleAccess !== undefined) patch.moduleAccess = normalizeRoleTemplateModules(body.moduleAccess);
  if (body.specialRights !== undefined) patch.specialRights = normalizeSpecialRights(body.specialRights);
  if (body.taskRights !== undefined) patch.taskRights = normalizeTaskRights(body.taskRights);
  return { patch };
}

router.use(requireRoleAuth, requireRoleFounder);

router.get('/', async (req, res) => {
  try {
    if (!isDbReady()) return ok(res, { data: { roles: [] }, roles: [] });
    await ensureSystemRoles(req);
    const roles = await Role.find({}).sort({ sortOrder: 1, isSystemRole: -1, name: 1 }).lean();
    const data = (roles || []).map(roleDto);
    const unsafeRoleTemplates = (roles || [])
      .map((role) => ({ role: roleDto(role), unsafePermissions: inspectUnsafeRoleTemplate(role) }))
      .filter((entry) => entry.unsafePermissions.length > 0);
    return ok(res, { data: { roles: data, unsafeRoleTemplates }, roles: data, unsafeRoleTemplates });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to list roles', 'LIST_ROLES_FAILED');
  }
});

router.post('/', async (req, res) => {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await ensureSystemRoles(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const validation = validateRoleTemplatePermissions(body);
    if (validation.error) return validationBad(res, validation.error);
    const parsed = parseRolePayload(body, null);
    if (parsed.error) return bad(res, parsed.error.status, parsed.error.message, parsed.error.code);
    if (parsed.patch.slug === 'founder') return bad(res, 403, 'Founder role is protected', 'FOUNDER_ROLE_PROTECTED');

    const existing = await Role.findOne({ slug: parsed.patch.slug }).lean();
    if (existing) return bad(res, 409, 'Role already exists', 'ROLE_EXISTS');

    const created = await Role.create({
      name: parsed.patch.name,
      slug: parsed.patch.slug,
      description: parsed.patch.description || '',
      sortOrder: typeof parsed.patch.sortOrder === 'number' ? parsed.patch.sortOrder : 100,
      isSystemRole: false,
      isProtected: false,
      moduleAccess: parsed.patch.moduleAccess || [],
      specialRights: parsed.patch.specialRights || [],
      taskRights: parsed.patch.taskRights || [],
      createdBy: actorId(req),
      updatedBy: actorId(req),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await logAudit(req, 'ROLE_CREATE', String(created._id), roleDto(created));
    return ok(res, { data: { role: roleDto(created) }, role: roleDto(created) }, 201);
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to create role', 'CREATE_ROLE_FAILED');
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await ensureSystemRoles(req);
    const role = await findRoleById(req.params.id, res);
    if (!role) return;
    return ok(res, { data: { role: roleDto(role) }, role: roleDto(role) });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to load role', 'LOAD_ROLE_FAILED');
  }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await ensureSystemRoles(req);
    const role = await findRoleById(req.params.id, res);
    if (!role) return;
    if (role.isProtected || role.slug === 'founder') return bad(res, 403, 'Founder role is protected', 'FOUNDER_ROLE_PROTECTED');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const validation = validateRoleTemplatePermissions(body);
    if (validation.error) return validationBad(res, validation.error);
    const parsed = parseRolePayload(body, role);
    if (parsed.error) return bad(res, parsed.error.status, parsed.error.message, parsed.error.code);
    if (parsed.patch.slug === 'founder') return bad(res, 403, 'Founder role is protected', 'FOUNDER_ROLE_PROTECTED');
    if (parsed.patch.slug && parsed.patch.slug !== role.slug) {
      const existing = await Role.findOne({ slug: parsed.patch.slug }).lean();
      if (existing) return bad(res, 409, 'Role already exists', 'ROLE_EXISTS');
    }

    Object.assign(role, parsed.patch, { updatedBy: actorId(req), updatedAt: new Date() });
    await role.save();

    await logAudit(req, 'ROLE_EDIT', String(role._id), roleDto(role));
    return ok(res, { data: { role: roleDto(role) }, role: roleDto(role) });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to update role', 'UPDATE_ROLE_FAILED');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await ensureSystemRoles(req);
    const role = await findRoleById(req.params.id, res);
    if (!role) return;
    if (role.isProtected || role.isSystemRole || role.slug === 'founder') return bad(res, 403, 'System role is protected', 'SYSTEM_ROLE_PROTECTED');

    const assigned = await User.countDocuments({ roleId: role._id });
    if (assigned > 0) return bad(res, 409, 'Role is assigned to users', 'ROLE_IN_USE');

    await Role.deleteOne({ _id: role._id });
    await logAudit(req, 'ROLE_DELETE', String(role._id), roleDto(role));
    return ok(res, { data: { deleted: true }, deleted: true });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to delete role', 'DELETE_ROLE_FAILED');
  }
});

module.exports = router;