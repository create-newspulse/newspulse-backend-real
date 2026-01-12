const express = require('express');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const { requireAdminAuth } = require('../middleware/adminAuth');

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

// GET /api/admin/audit/logs?limit=50
router.get('/audit/logs', requireAdminAuth, requireFounderOrPermission('audit:read'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);

  if (!isDbReady()) {
    return ok(res, { items: [] });
  }

  const docs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();

  const items = (docs || []).map(d => ({
    id: String(d._id),
    action: d.action,
    key: d.key ?? null,
    actor: d.actor ?? null,
    ip: d.ip ?? null,
    userAgent: d.userAgent ?? null,
    meta: d.meta ?? null,
    createdAt: d.createdAt ?? null,
  }));

  return ok(res, { items });
});

module.exports = router;
