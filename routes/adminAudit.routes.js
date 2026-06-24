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
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'founder') return true;
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const specialRights = Array.isArray(req.user?.specialRights) ? req.user.specialRights : [];
  return permissions.includes(perm) || specialRights.includes(perm) || (perm === 'audit.read' && specialRights.includes('audit_log_view'));
}

function requireFounderOrPermission(perm) {
  return (req, res, next) => {
    if (!req.user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    if (!hasPermission(req, perm)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
    return next();
  };
}

function parseLimit(value) {
  return Math.min(Math.max(parseInt(value || '50', 10), 1), 200);
}

function buildAuditQuery(query = {}) {
  const filter = {};
  const start = query.startDate || query.from || query.dateFrom;
  const end = query.endDate || query.to || query.dateTo;
  if (start || end) {
    filter.createdAt = {};
    if (start) {
      const date = new Date(start);
      if (!Number.isNaN(date.getTime())) filter.createdAt.$gte = date;
    }
    if (end) {
      const date = new Date(end);
      if (!Number.isNaN(date.getTime())) filter.createdAt.$lte = date;
    }
    if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
  }
  if (query.actor) filter.$or = [{ 'actor.id': String(query.actor) }, { 'actor.email': String(query.actor).toLowerCase() }, { 'actor.staffId': String(query.actor).toUpperCase() }];
  if (query.role) filter['actor.role'] = String(query.role).toLowerCase();
  if (query.module) filter.module = String(query.module);
  if (query.action) filter.action = String(query.action);
  if (query.target) filter.targetId = String(query.target);
  if (query.result) filter.result = String(query.result);
  if (query.severity) filter.severity = String(query.severity);
  if (query.ipAddress || query.ip) filter.ip = String(query.ipAddress || query.ip);
  if (query.q || query.search) {
    const regex = new RegExp(String(query.q || query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const searchOr = [
      { action: regex },
      { key: regex },
      { 'actor.email': regex },
      { 'actor.name': regex },
      { 'actor.staffId': regex },
      { targetName: regex },
      { reason: regex },
    ];
    if (filter.$or) filter.$and = [{ $or: filter.$or }, { $or: searchOr }], delete filter.$or;
    else filter.$or = searchOr;
  }
  return filter;
}

function auditDto(d) {
  return {
    id: String(d._id),
    _id: String(d._id),
    timestamp: d.createdAt ?? null,
    createdAt: d.createdAt ?? null,
    actorUserId: d.actor && d.actor.id ? String(d.actor.id) : null,
    actorName: d.actor?.name ?? null,
    actorEmail: d.actor?.email ?? null,
    actorStaffId: d.actor?.staffId ?? null,
    actorRole: d.actor?.role ?? null,
    action: d.action,
    targetType: d.targetType ?? null,
    targetId: d.targetId ?? extractTargetUserId(d),
    targetName: d.targetName ?? null,
    module: d.module ?? null,
    oldValue: d.oldValue ?? null,
    newValue: d.newValue ?? null,
    result: d.result ?? 'success',
    reason: d.reason ?? null,
    ipAddress: d.ip ?? null,
    device: d.userAgent ?? null,
    browser: d.userAgent ?? null,
    sessionId: d.sessionId ?? null,
    severity: d.severity ?? 'info',
    requestId: d.requestId ?? null,
    key: d.key ?? null,
    actor: d.actor ?? null,
    meta: d.meta ?? null,
  };
}

// GET /api/admin/audit/logs?limit=50
router.get('/audit/logs', requireAuth, requireFounderOrPermission('audit.read'), async (req, res) => {
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
router.get('/audit', requireAuth, requireFounderOrPermission('audit.read'), async (req, res) => {
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
router.get('/audit-logs', requireAuth, requireFounderOrPermission('audit.read'), async (req, res) => {
  const limit = parseLimit(req.query.limit);

  if (!isDbReady()) {
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'OK', data: { items: [] }, items: [], events: [] });
  }

  const filter = buildAuditQuery(req.query || {});
  const docs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  const items = (docs || []).map(auditDto);
  return res.status(200).json({ ok: true, success: true, status: 200, message: 'OK', data: { items }, items, events: items });
});

router.get('/audit-logs/:id', requireAuth, requireFounderOrPermission('audit.read'), async (req, res) => {
  if (!isDbReady()) return bad(res, 404, 'Audit log not found', 'NOT_FOUND');
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid id', 'INVALID_ID');
  const doc = await AuditLog.findById(String(req.params.id)).lean();
  if (!doc) return bad(res, 404, 'Audit log not found', 'NOT_FOUND');
  const item = auditDto(doc);
  return res.status(200).json({ ok: true, success: true, status: 200, message: 'OK', data: { item }, item });
});

// Alias: some admin builds call /api/admin/audit/events?limit=50
router.get('/audit/events', requireAuth, requireFounderOrPermission('audit.read'), async (req, res) => {
  req.url = '/audit' + (req._parsedUrl && req._parsedUrl.search ? req._parsedUrl.search : '');
  return router.handle(req, res);
});

module.exports = router;
