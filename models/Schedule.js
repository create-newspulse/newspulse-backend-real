const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  userIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [], index: true },
  roleIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Role', default: [], index: true },
  startTime: { type: String, required: true, trim: true },
  endTime: { type: String, required: true, trim: true },
  weeklyOffDays: { type: [Number], default: [] },
  timezone: { type: String, default: 'Asia/Kolkata', trim: true },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

scheduleSchema.index({ active: 1, title: 1 });

scheduleSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Schedule || mongoose.model('Schedule', scheduleSchema);