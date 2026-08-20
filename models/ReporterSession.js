const crypto = require('crypto');
const mongoose = require('mongoose');

const ReporterSessionSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterContact', required: true, index: true },
  email: { type: String, required: true, trim: true, lowercase: true, index: true },
  tokenHash: { type: String, required: true, index: true, unique: true },
  portalAuthVersion: { type: Number, required: false, default: 0, index: true },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, default: null, index: true },
  revokedReason: { type: String, trim: true, default: null },
  userAgent: { type: String, trim: true, default: null },
  ipAddress: { type: String, trim: true, default: null },
}, { timestamps: true });

ReporterSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ReporterSessionSchema.index({ reporterId: 1, revokedAt: 1, expiresAt: 1 });

ReporterSessionSchema.statics.hashToken = function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
};

module.exports = mongoose.model('ReporterSession', ReporterSessionSchema);