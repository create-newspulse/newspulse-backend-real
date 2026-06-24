const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

const SECRET_FIELD_RE = /(password|token|secret|key|api[_-]?key|smtp|mongo|uri|hash|jwt|private|dsc)/i;

function sanitizeAuditValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key)) continue;
    out[key] = sanitizeAuditValue(item);
  }
  return out;
}

function getReqIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  const ip = xf.split(',')[0].trim() || req.socket?.remoteAddress || null;
  return ip || null;
}

async function logAudit(req, action, targetUserId = null, meta = null) {
  try {
    if (!isDbReady()) return;

    const actor = req.user || req.admin || null;
    const actorId = actor && actor.id ? String(actor.id) : null;
    const actorEmail = actor && actor.email ? String(actor.email) : null;
    const actorRole = actor && actor.role ? String(actor.role) : null;
    const safeMeta = sanitizeAuditValue(meta ? meta : {});
    const targetId = safeMeta.targetId || safeMeta.targetUserId || (targetUserId ? String(targetUserId) : null);

    const doc = {
      action: String(action || '').slice(0, 200) || 'UNKNOWN',
      key: targetUserId ? `user:${String(targetUserId)}` : null,
      actor: {
        id: actorId,
        name: actor && (actor.fullName || actor.name) ? String(actor.fullName || actor.name).slice(0, 200) : null,
        email: actorEmail,
        staffId: actor && actor.staffId ? String(actor.staffId).slice(0, 80) : null,
        role: actorRole,
      },
      targetType: safeMeta.targetType ? String(safeMeta.targetType).slice(0, 100) : (targetId ? 'staff' : null),
      targetId: targetId ? String(targetId) : null,
      targetName: safeMeta.targetName ? String(safeMeta.targetName).slice(0, 200) : null,
      module: safeMeta.module ? String(safeMeta.module).slice(0, 100) : null,
      oldValue: safeJson(safeMeta.oldValue),
      newValue: safeJson(safeMeta.newValue),
      result: ['success', 'failed', 'blocked'].includes(String(safeMeta.result || 'success')) ? String(safeMeta.result || 'success') : 'success',
      reason: safeMeta.reason ? String(safeMeta.reason).slice(0, 500) : null,
      severity: ['info', 'warning', 'critical'].includes(String(safeMeta.severity || 'info')) ? String(safeMeta.severity || 'info') : 'info',
      requestId: String(req.headers['x-request-id'] || req.headers['x-correlation-id'] || safeMeta.requestId || '').slice(0, 120) || null,
      sessionId: actor && actor.currentSessionId ? String(actor.currentSessionId) : (safeMeta.sessionId ? String(safeMeta.sessionId).slice(0, 120) : null),
      ip: getReqIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
      meta: safeJson({ targetUserId: targetUserId ? String(targetUserId) : null, ...safeMeta }),
    };

    await AuditLog.create(doc);
  } catch (_) {
    // Intentionally swallow audit failures
  }
}

module.exports = { logAudit };
