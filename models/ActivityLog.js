const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  type: { type: String, required: true }, // e.g. login, otp_request, otp_verify, password_reset
  email: { type: String, lowercase: true, trim: true },
  meta: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
