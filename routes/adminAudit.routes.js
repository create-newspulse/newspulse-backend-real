const express = require('express');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');

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

function extractTargetUserId(d) {
  if (d && d.meta && typeof d.meta === 'object' && d.meta.targetUserId) return String(d.meta.targetUserId);
  const key = d && d.key ? String(d.key) : '';
  if (key.startsWith('user:')) return key.slice(5) || null;
  return null;
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
router.get('/audit/logs', requireAuth, requireFounder, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);

  if (!isDbReady()) {
    // Return both legacy and new admin UI shapes.
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      data: { items: [] },
      items: [],
      events: [],
    });
  }

  const docs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();

  const items = (docs || []).map(d => ({
    id: String(d._id),
    action: d.action,
    key: d.key ?? null,
    actor: d.actor ?? null,
    actorUserId: d.actor && d.actor.id ? String(d.actor.id) : null,
    actorEmail: d.actor && d.actor.email ? String(d.actor.email) : null,
    targetUserId: extractTargetUserId(d),
    ip: d.ip ?? null,
    userAgent: d.userAgent ?? null,
    meta: d.meta ?? null,
    createdAt: d.createdAt ?? null,
  }));

  const events = (docs || []).map((d) => ({
    _id: String(d._id),
    at: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    actorUserId: d.actor && d.actor.id ? String(d.actor.id) : null,
    actorEmail: d.actor && d.actor.email ? String(d.actor.email) : null,
    action: d.action || null,
    targetUserId: extractTargetUserId(d),
    meta: d.meta ?? {},
  }));

  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    message: 'OK',
    data: { items },
    items,
    events,
  });
});

// GET /api/admin/audit?limit=50
// Admin Panel compatibility: older/newer UIs call /api/admin/audit (not /audit/logs)
router.get('/audit', requireAuth, requireFounder, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);

  if (!isDbReady()) {
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      data: { events: [] },
      events: [],
    });
  }

  const docs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  const events = (docs || []).map((d) => ({
    _id: String(d._id),
    at: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    actorUserId: d.actor && d.actor.id ? String(d.actor.id) : null,
    actorEmail: d.actor && d.actor.email ? String(d.actor.email) : null,
    action: d.action || null,
    targetUserId: extractTargetUserId(d),
    meta: d.meta ?? {},
  }));

  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    message: 'OK',
    data: { events },
    events,
  });
});

// Alias: some admin builds call /api/admin/audit-logs?limit=50
router.get('/audit-logs', requireAuth, requireFounder, async (req, res) => {
  req.url = '/audit' + (req._parsedUrl && req._parsedUrl.search ? req._parsedUrl.search : '');
  return router.handle(req, res);
});

// Alias: some admin builds call /api/admin/audit/events?limit=50
router.get('/audit/events', requireAuth, requireFounder, async (req, res) => {
  req.url = '/audit' + (req._parsedUrl && req._parsedUrl.search ? req._parsedUrl.search : '');
  return router.handle(req, res);
});

module.exports = router;
