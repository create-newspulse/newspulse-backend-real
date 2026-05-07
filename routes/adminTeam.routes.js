const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

const TEAM_SELECTABLE_ROLES = Object.freeze(['editor']);
const DEFAULT_FOUNDER_EMAIL = 'newspulse.team@gmail.com';

function hasPermission(req, perm) {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'founder') return true;
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  return permissions.includes(perm);
}

function requireFounderOrPermission(perm) {
  return (req, res, next) => {
    if (!req.user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    if (!hasPermission(req, perm)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
    return next();
  };
}

function syncReqUserFromAdmin(req) {
  if (!req.admin) return;
  req.user = {
    id: req.admin.id || null,
    email: req.admin.email || null,
    name: req.admin.name || null,
    role: req.admin.role || null,
    designation: req.admin.designation || null,
    permissions: Array.isArray(req.admin.permissions) ? req.admin.permissions : [],
    status: req.admin.status || 'active',
    mustChangePassword: Boolean(req.admin.mustChangePassword),
    tokenVersion: typeof req.admin.tokenVersion === 'number' ? req.admin.tokenVersion : 0,
  };
}

function requireTeamAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return requireAuth(req, res, next);
  }

  return requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return next(err);
    syncReqUserFromAdmin(req);
    return next();
  });
}

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, status: 200, data });
}

function bad(res, status, message, code = null) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function teamUserSafeDto(u) {
  return {
    _id: String(u._id),
    id: String(u._id),
    name: u.name || '',
    email: u.email || '',
    role: u.role || 'editor',
    designation: u.designation || null,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    status: u.status || 'active',
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null,
    mustChangePassword: Boolean(u.mustChangePassword || u.mustResetPassword || u.forceReset),
  };
}

function userDto(u) {
  return {
    id: String(u._id),
    name: u.name || '',
    email: u.email || '',
    role: u.role || 'editor',
    designation: u.designation || null,
    status: u.status || 'active',
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null,
    mustChangePassword: Boolean(u.mustChangePassword || u.mustResetPassword || u.forceReset),
  };
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'founder' || role === 'admin' || role === 'editor' || role === 'staff') return role;
  return null;
}

function normalizeSelectableRole(value) {
  const role = normalizeRole(value);
  if (!role) return null;
  return TEAM_SELECTABLE_ROLES.includes(role) ? role : null;
}

function getFounderEmails() {
  return new Set(
    [
      process.env.FOUNDER_EMAIL,
      process.env.ADMIN_EMAIL,
      process.env.ADMIN_SEED_FOUNDER_EMAIL,
      DEFAULT_FOUNDER_EMAIL,
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

function isProtectedFounderUser(user) {
  if (!user) return false;
  const role = String(user.role || '').trim().toLowerCase();
  if (role === 'founder') return true;

  const email = String(user.email || '').trim().toLowerCase();
  return email ? getFounderEmails().has(email) : false;
}

async function findUserByIdOr404(id, res) {
  const user = await User.findById(id);
  if (!user) {
    bad(res, 404, 'Not found');
    return null;
  }
  return user;
}

function availableRolesPayload() {
  return TEAM_SELECTABLE_ROLES.slice();
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (p.length > 100) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 100) break;
  }
  return out;
}

function generateTempPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function setTempPasswordAndForceChange(userId) {
  const tempPassword = generateTempPassword();
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  const passwordHash = await bcrypt.hash(tempPassword, rounds);

  const updated = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        passwordHash,
        mustResetPassword: true,
        mustChangePassword: true,
        forceReset: true,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );

  return { updated, tempPassword };
}

// GET /api/admin/team/users
router.get('/team/users', requireTeamAuth, requireFounderOrPermission('team.manage'), async (_req, res) => {
  if (!isDbReady()) {
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK (DB unavailable)',
      data: { users: [], availableRoles: availableRolesPayload() },
      availableRoles: availableRolesPayload(),
      users: [],
    });
  }

  const docs = await User.find({ role: { $in: ['founder', 'admin', 'editor', 'staff'] } })
    .sort({ createdAt: -1 })
    .lean();

  const users = (docs || []).map(teamUserSafeDto);
  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    message: 'OK',
    data: { users, availableRoles: availableRolesPayload() },
    availableRoles: availableRolesPayload(),
    users,
  });
});

// POST /api/admin/team/users
// Founder-only: creates user and returns one-time tempPassword
router.post('/team/users', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fullName = String(body.fullName || body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const roleInputPresent = body.role !== undefined && body.role !== null && String(body.role || '').trim() !== '';
  const role = roleInputPresent ? normalizeSelectableRole(body.role) : 'editor';
  const designation = body.designation != null ? String(body.designation || '').trim() : null;
  const permissions = normalizePermissions(body.permissions);

  if (!fullName) return bad(res, 400, 'fullName is required');
  if (!email) return bad(res, 400, 'Blank email not allowed', 'INVALID_EMAIL');
  if (!role) return bad(res, 400, 'Invalid role not allowed', 'INVALID_ROLE');
  if (getFounderEmails().has(email)) return bad(res, 409, 'Duplicate founder email not allowed', 'DUPLICATE_FOUNDER_EMAIL');

  const existing = await User.findOne({ email }).lean();
  if (existing) return bad(res, 409, 'Email already exists');

  const tempPassword = generateTempPassword();
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  const passwordHash = await bcrypt.hash(tempPassword, rounds);

  const created = await User.create({
    email,
    name: fullName,
    passwordHash,
    role,
    designation: designation || null,
    permissions,
    status: 'active',
    mustResetPassword: true,
    mustChangePassword: true,
    forceReset: true,
    tokenVersion: 0,
    createdBy: mongoose.isValidObjectId(req.user?.id) ? req.user.id : null,
    updatedBy: mongoose.isValidObjectId(req.user?.id) ? req.user.id : null,
    createdAt: new Date(),
  });

  await logAudit(req, 'TEAM_CREATE_USER', String(created._id), { email, role });

  return res.status(201).json({
    ok: true,
    success: true,
    status: 201,
    data: { user: userDto(created), tempPassword },
  });
});

// PATCH /api/admin/team/users/:id
// Founder-only: updates role/designation/permissions/fullName
router.patch('/team/users/:id', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const existingUser = await findUserByIdOr404(id, res);
  if (!existingUser) return;
  if (isProtectedFounderUser(existingUser)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const patch = {};
  if (body.fullName != null || body.name != null) {
    const fullName = String(body.fullName || body.name || '').trim();
    if (!fullName) return bad(res, 400, 'fullName is required');
    patch.name = fullName;
  }
  if (body.role != null) {
    const role = normalizeSelectableRole(body.role);
    if (!role) return bad(res, 400, 'Invalid role not allowed', 'INVALID_ROLE');
    patch.role = role;
  }
  if (body.designation !== undefined) {
    patch.designation = body.designation != null ? String(body.designation || '').trim() : null;
  }
  if (body.permissions !== undefined) {
    patch.permissions = normalizePermissions(body.permissions);
  }

  patch.updatedBy = mongoose.isValidObjectId(req.user?.id) ? req.user.id : null;

  const updated = await User.findByIdAndUpdate(id, { $set: patch }, { new: true });
  if (!updated) return bad(res, 404, 'Not found');

  await logAudit(req, 'TEAM_UPDATE_USER', id, { fields: Object.keys(patch).filter(k => k !== 'updatedBy') });
  return ok(res, { user: userDto(updated) });
});

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'active' || status === 'suspended') return status;
  return null;
}

// PATCH /api/admin/team/users/:id/status  body: { status: 'active'|'suspended' }
// Founder-only
router.patch('/team/users/:id/status', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const targetUser = await findUserByIdOr404(id, res);
  if (!targetUser) return;
  if (isProtectedFounderUser(targetUser)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const status = normalizeStatus(body.status);
  if (!status) return bad(res, 400, 'Invalid status. Expected active|suspended');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');

  await logAudit(req, status === 'active' ? 'TEAM_ACTIVATE_USER' : 'TEAM_SUSPEND_USER', id, null);
  return ok(res, { user: userDto(updated) });
});

// POST /api/admin/team/users/:id/activate
router.post('/team/users/:id/activate', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const targetUser = await findUserByIdOr404(id, res);
  if (!targetUser) return;
  if (isProtectedFounderUser(targetUser)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status: 'active' }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');
  await logAudit(req, 'TEAM_ACTIVATE_USER', id, null);
  return ok(res, { user: userDto(updated) });
});

// POST /api/admin/team/users/:id/suspend
router.post('/team/users/:id/suspend', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const targetUser = await findUserByIdOr404(id, res);
  if (!targetUser) return;
  if (isProtectedFounderUser(targetUser)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');
  await logAudit(req, 'TEAM_SUSPEND_USER', id, null);
  return ok(res, { user: userDto(updated) });
});

// POST /api/admin/team/users/:id/force-reset
router.post('/team/users/:id/force-reset', requireTeamAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const targetUser = await findUserByIdOr404(id, res);
  if (!targetUser) return;
  if (isProtectedFounderUser(targetUser)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const { updated, tempPassword } = await setTempPasswordAndForceChange(id);
  if (!updated) return bad(res, 404, 'Not found');

  await logAudit(req, 'TEAM_FORCE_RESET', id, null);
  return ok(res, { user: userDto(updated), tempPassword });
});

// Backward-compat aliases (older UIs used PATCH instead of POST)
router.patch('/team/users/:id/activate', requireTeamAuth, requireFounder, (req, res) => {
  req.method = 'POST';
  req.url = `/team/users/${req.params.id}/activate`;
  return router.handle(req, res);
});

router.patch('/team/users/:id/suspend', requireTeamAuth, requireFounder, (req, res) => {
  req.method = 'POST';
  req.url = `/team/users/${req.params.id}/suspend`;
  return router.handle(req, res);
});

module.exports = router;
