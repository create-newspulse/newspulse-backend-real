const mongoose = require('mongoose');

const dpdpAuditLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, index: true, trim: true },
    action: { type: String, required: true, index: true, trim: true },
    source: { type: String, default: null, trim: true },
    recordId: { type: String, default: null, trim: true },
    oldStatus: { type: String, default: null, trim: true },
    newStatus: { type: String, default: null, trim: true },
    adminNote: { type: String, default: null, trim: true },
    handledBy: { type: String, default: null, trim: true },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, collection: 'dpdp_audit_logs' },
);

dpdpAuditLogSchema.index({ requestId: 1, timestamp: -1 });

module.exports = mongoose.models.DpdpAuditLog || mongoose.model('DpdpAuditLog', dpdpAuditLogSchema);
