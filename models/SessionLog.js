const mongoose = require('mongoose');

const sessionLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  loginAt: { type: Date, default: Date.now, index: true },
  logoutAt: { type: Date, default: null, index: true },
  lastSeenAt: { type: Date, default: Date.now, index: true },
  ipAddress: { type: String, default: null, trim: true },
  userAgent: { type: String, default: null, trim: true },
  device: { type: String, default: null, trim: true },
  status: { type: String, enum: ['active', 'ended', 'expired'], default: 'active', index: true },
  logoutReason: { type: String, default: null, trim: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

sessionLogSchema.index({ userId: 1, loginAt: -1 });
sessionLogSchema.index({ status: 1, lastSeenAt: -1 });

module.exports = mongoose.models.SessionLog || mongoose.model('SessionLog', sessionLogSchema);