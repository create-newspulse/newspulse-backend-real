const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: Date, required: true, index: true },
  checkInAt: { type: Date, default: null },
  checkOutAt: { type: Date, default: null },
  totalWorkMinutes: { type: Number, default: 0, min: 0 },
  totalBreakMinutes: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['present', 'absent', 'late', 'half_day', 'on_leave', 'off_day'], default: 'present', index: true },
  shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Schedule', default: null, index: true },
  notes: { type: String, default: null, trim: true },
  correctionRequested: { type: Boolean, default: false, index: true },
  correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  correctedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

attendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: -1, status: 1 });

attendanceSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);