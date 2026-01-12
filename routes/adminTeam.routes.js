const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
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

function hasPermission(req, perm) {
  const role = String(req.admin?.role || '').toLowerCase();
  if (role === 'founder') return true;
  const permissions = Array.isArray(req.admin?.permissions) ? req.admin.permissions : [];
  return permissions.includes(perm);
}

function requireFounderOrPermission(perm) {
  return (req, res, next) => {
    if (!req.admin) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    if (!hasPermission(req, perm)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
    return next();
  };
}

function teamUserSafeDto(u) {
  return {
    id: String(u._id),
    name: u.name || '',
    email: u.email || '',
    role: u.role || 'staff',
    status: u.status || 'active',
    createdAt: u.createdAt || null,
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
    mustResetPassword: Boolean(u.mustResetPassword || u.mustChangePassword || u.forceReset),
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

// GET /api/admin/team/users
router.get('/team/users', requireAdminAuth, async (_req, res) => {
  if (!isDbReady()) {
    return res.status(200).json({ ok: true, success: true, status: 200, users: [] });
  }

  const docs = await User.find({ role: { $in: ['founder', 'admin', 'editor', 'staff'] } })
    .sort({ createdAt: -1 })
    .lean();

  const users = (docs || []).map(teamUserSafeDto);
  return res.status(200).json({ ok: true, success: true, status: 200, users });
});

// POST /api/admin/team/users
// Founder-only: creates user and returns one-time tempPassword
router.post('/team/users', requireFounderAuth, async (req, res) => {
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
    createdBy: mongoose.isValidObjectId(req.admin?.id) ? req.admin.id : null,
    updatedBy: mongoose.isValidObjectId(req.admin?.id) ? req.admin.id : null,
    createdAt: new Date(),
  });

  await logAudit(req, 'TEAM_CREATE', String(created._id), { email, role });

  return res.status(201).json({
    ok: true,
    success: true,
    status: 201,
    data: { user: userDto(created), tempPassword },
  });
});

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'active' || status === 'suspended') return status;
  return null;
}

// PATCH /api/admin/team/users/:id/status  body: { status: 'active'|'suspended' }
// Founder-only
router.patch('/team/users/:id/status', requireFounderAuth, async (req, res) => {
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

  await logAudit(req, status === 'active' ? 'TEAM_ACTIVATE' : 'TEAM_SUSPEND', id, null);
  return ok(res, { user: userDto(updated) });
});

// PATCH /api/admin/team/users/:id/activate
router.patch('/team/users/:id/activate', requireFounderAuth, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status: 'active' }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');
  await logAudit(req, 'TEAM_ACTIVATE', id, null);
  return ok(res, { user: userDto(updated) });
});

// PATCH /api/admin/team/users/:id/suspend
router.patch('/team/users/:id/suspend', requireFounderAuth, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');
  await logAudit(req, 'TEAM_SUSPEND', id, null);
  return ok(res, { user: userDto(updated) });
});

// POST /api/admin/team/users/:id/force-reset
router.post('/team/users/:id/force-reset', requireFounderAuth, async (req, res) => {
  if (!isDbReady()) return bad(res, 503, 'Database unavailable');

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return bad(res, 400, 'Invalid id');

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { mustResetPassword: true, mustChangePassword: true, forceReset: true }, $inc: { tokenVersion: 1 } },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found');
  await logAudit(req, 'TEAM_FORCE_RESET', id, null);

  return ok(res, { ok: true });
});

module.exports = router;
