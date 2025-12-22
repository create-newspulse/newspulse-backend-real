const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const { requireFounderAuth } = require('../middleware/adminAuth');

const router = express.Router();

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function ensureDbOr503(res) {
  if (!isDbReady()) {
    res.status(503).json({ success: false, data: null, message: 'Database unavailable' });
    return false;
  }
  return true;
}

function sanitizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  // Keep intentionally small; expand only when product needs it.
  if (role === 'admin' || role === 'staff') return role;
  return null;
}

function sanitizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'active' || status === 'suspended') return status;
  return null;
}

function sanitizePermissions(value) {
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

function toStaffDto(u) {
  return {
    id: String(u._id),
    name: u.name || '',
    email: u.email || '',
    role: u.role || 'staff',
    designation: u.designation || null,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    status: u.status || 'active',
    createdAt: u.createdAt || null,
  };
}

// Founder-only: list staff accounts
// GET /api/admin/staff
router.get('/', requireFounderAuth, async (_req, res) => {
  // For local dev without DB, return a stable success shape (avoids UI hard-fail).
  if (!isDbReady()) {
    return res.status(200).json({ success: true, data: [], message: 'Database unavailable' });
  }

  const docs = await User.find({ role: { $in: ['admin', 'staff', 'founder'] } })
    .sort({ createdAt: -1 })
    .lean();

  const items = docs.map(d => ({
    id: String(d._id),
    name: d.name || '',
    email: d.email || '',
    role: d.role || 'staff',
    designation: d.designation || null,
    permissions: Array.isArray(d.permissions) ? d.permissions : [],
    status: d.status || 'active',
    createdAt: d.createdAt || null,
  }));

  return res.status(200).json({ success: true, data: items });
});

// Founder-only: create staff account
// POST /api/admin/staff
router.post('/', requireFounderAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const role = sanitizeRole(body.role) || 'staff';
  const designation = body.designation != null ? String(body.designation || '').trim() : '';
  const permissions = sanitizePermissions(body.permissions);

  if (!email) return res.status(400).json({ success: false, data: null, message: 'email is required' });
  if (!name) return res.status(400).json({ success: false, data: null, message: 'name is required' });
  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, data: null, message: 'password must be at least 8 characters' });
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) return res.status(409).json({ success: false, data: null, message: 'Email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);

  const created = await User.create({
    email,
    name,
    passwordHash,
    role,
    designation: designation || null,
    permissions,
    status: 'active',
    forceReset: false,
    createdAt: new Date(),
  });

  return res.status(201).json({ success: true, data: toStaffDto(created), message: 'Staff account created' });
});

// Founder-only: update status
// PATCH /api/admin/staff/:id/status  body: { status: 'active'|'suspended' }
router.patch('/:id/status', requireFounderAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, data: null, message: 'Invalid id' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const status = sanitizeStatus(body.status);
  if (!status) {
    return res.status(400).json({ success: false, data: null, message: 'Invalid status. Expected active|suspended' });
  }

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { status } },
    { new: true },
  );

  if (!updated) return res.status(404).json({ success: false, data: null, message: 'Not found' });
  return res.status(200).json({ success: true, data: toStaffDto(updated), message: 'Status updated' });
});

// Founder-only: force password reset
// POST /api/admin/staff/:id/force-reset
router.post('/:id/force-reset', requireFounderAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, data: null, message: 'Invalid id' });
  }

  const updated = await User.findByIdAndUpdate(
    id,
    { $set: { forceReset: true } },
    { new: true },
  );

  if (!updated) return res.status(404).json({ success: false, data: null, message: 'Not found' });
  return res.status(200).json({ success: true, data: toStaffDto(updated), message: 'Force reset enabled' });
});

module.exports = router;
