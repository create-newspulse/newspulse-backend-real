const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    key: { type: String, default: null, index: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    actor: {
      id: { type: String, default: null },
      name: { type: String, default: null },
      email: { type: String, default: null },
      staffId: { type: String, default: null },
      role: { type: String, default: null },
    },
    targetType: { type: String, default: null, index: true },
    targetId: { type: String, default: null, index: true },
    targetName: { type: String, default: null },
    module: { type: String, default: null, index: true },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: String, enum: ['success', 'failed', 'blocked'], default: 'success', index: true },
    reason: { type: String, default: null },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info', index: true },
    requestId: { type: String, default: null, index: true },
    sessionId: { type: String, default: null, index: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: 'audit_logs' },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ 'actor.id': 1, createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
