const express = require('express');
const mongoose = require('mongoose');

const Role = require('../models/Role');
const User = require('../models/User');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const {
  ADMIN_MODULE_KEYS,
  SPECIAL_RIGHT_KEYS,
  SYSTEM_ROLE_DEFINITIONS,
  normalizeModuleAccess,
  normalizeSpecialRights,
} = require('../lib/teamAccess');

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
    createdBy: role.createdBy || null,
    createdAt: role.createdAt || null,
    updatedAt: role.updatedAt || null,
  };
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
  if (body.moduleAccess !== undefined) patch.moduleAccess = normalizeModuleAccess(body.moduleAccess);
  if (body.specialRights !== undefined) patch.specialRights = normalizeSpecialRights(body.specialRights);
  return { patch };
}

router.use(requireAuth, requireFounder);

router.get('/', async (req, res) => {
  try {
    if (!isDbReady()) return ok(res, { data: { roles: [] }, roles: [] });
    await ensureSystemRoles(req);
    const roles = await Role.find({}).sort({ sortOrder: 1, isSystemRole: -1, name: 1 }).lean();
    const data = (roles || []).map(roleDto);
    return ok(res, { data: { roles: data }, roles: data });
  } catch (err) {
    return bad(res, 500, err?.message || 'Failed to list roles', 'LIST_ROLES_FAILED');
  }
});

router.post('/', async (req, res) => {
  try {
    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
    await ensureSystemRoles(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
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