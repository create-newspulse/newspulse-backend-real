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

    const doc = {
      action: String(action || '').slice(0, 200) || 'UNKNOWN',
      key: targetUserId ? `user:${String(targetUserId)}` : null,
      actor: { id: actorId, email: actorEmail, role: actorRole },
      ip: getReqIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
      meta: safeJson({ targetUserId: targetUserId ? String(targetUserId) : null, ...(meta ? meta : {}) }),
    };

    await AuditLog.create(doc);
  } catch (_) {
    // Intentionally swallow audit failures
  }
}

module.exports = { logAudit };
