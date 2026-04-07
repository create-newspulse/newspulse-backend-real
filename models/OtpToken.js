const mongoose = require('mongoose');

const otpTokenSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  purpose: { type: String, required: true, trim: true, default: 'admin_otp' },
  challengeId: { type: String, trim: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['active', 'expired', 'consumed', 'replaced'],
    default: 'active',
    index: true,
  },
  used: { type: Boolean, default: false },
  consumedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
  replacedAt: { type: Date, default: null },
  replacedByChallengeId: { type: String, trim: true, default: null },
  resetToken: { type: String },
  resetTokenExpiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // auto-delete after 1 hour
});

// Index for faster lookups
otpTokenSchema.index({ email: 1, codeHash: 1 });
otpTokenSchema.index({ email: 1, purpose: 1, used: 1, createdAt: -1 });
otpTokenSchema.index({ email: 1, purpose: 1, status: 1, createdAt: -1 });
otpTokenSchema.index({ email: 1, purpose: 1, challengeId: 1 });
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpToken', otpTokenSchema);
