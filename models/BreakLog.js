const mongoose = require('mongoose');

const breakLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true, index: true },
  breakStartAt: { type: Date, default: Date.now, index: true },
  breakEndAt: { type: Date, default: null },
  totalMinutes: { type: Number, default: 0, min: 0 },
  reason: { type: String, default: null, trim: true },
  status: { type: String, enum: ['active', 'ended'], default: 'active', index: true },
  createdAt: { type: Date, default: Date.now },
});

breakLogSchema.index({ userId: 1, status: 1, breakStartAt: -1 });
breakLogSchema.index({ attendanceId: 1, status: 1 });

module.exports = mongoose.models.BreakLog || mongoose.model('BreakLog', breakLogSchema);