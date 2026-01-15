const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

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
    role: u.role || 'staff',
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
    role: u.role || 'staff',
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
router.get('/team/users', requireAuth, requireFounder, async (_req, res) => {
  if (!isDbReady()) {
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK (DB unavailable)',
      data: { users: [] },
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
    data: { users },
    users,
  });
});

// POST /api/admin/team/users
// Founder-only: creates user and returns one-time tempPassword
router.post('/team/users', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fullName = String(body.fullName || body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const role = normalizeRole(body.role) || 'staff';
  const designation = body.designation != null ? String(body.designation || '').trim() : null;
  const permissions = normalizePermissions(body.permissions);

  if (!fullName) return bad(res, 400, 'fullName is required');
  if (!email) return bad(res, 400, 'email is required');

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
router.patch('/team/users/:id', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const patch = {};
  if (body.fullName != null || body.name != null) {
    const fullName = String(body.fullName || body.name || '').trim();
    if (!fullName) return bad(res, 400, 'fullName is required');
    patch.name = fullName;
  }
  if (body.role != null) {
    const role = normalizeRole(body.role);
    if (!role) return bad(res, 400, 'Invalid role');
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
router.patch('/team/users/:id/status', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

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
router.post('/team/users/:id/activate', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

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
router.post('/team/users/:id/suspend', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

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
router.post('/team/users/:id/force-reset', requireAuth, requireFounder, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const { updated, tempPassword } = await setTempPasswordAndForceChange(id);
  if (!updated) return bad(res, 404, 'Not found');

  await logAudit(req, 'TEAM_FORCE_RESET', id, null);
  return ok(res, { user: userDto(updated), tempPassword });
});

// Backward-compat aliases (older UIs used PATCH instead of POST)
router.patch('/team/users/:id/activate', requireAuth, requireFounder, (req, res) => {
  req.method = 'POST';
  req.url = `/team/users/${req.params.id}/activate`;
  return router.handle(req, res);
});

router.patch('/team/users/:id/suspend', requireAuth, requireFounder, (req, res) => {
  req.method = 'POST';
  req.url = `/team/users/${req.params.id}/suspend`;
  return router.handle(req, res);
});

module.exports = router;
