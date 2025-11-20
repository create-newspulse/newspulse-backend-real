const mongoose = require('mongoose');

const otpTokenSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
  resetToken: { type: String },
  resetTokenExpiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now, expires: 3600 } // auto-delete after 1 hour
});

// Index for faster lookups
otpTokenSchema.index({ email: 1, codeHash: 1 });
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpToken', otpTokenSchema);
