const mongoose = require('mongoose');

const offDaySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: Date, required: true, index: true },
  reason: { type: String, default: null, trim: true },
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

offDaySchema.index({ userId: 1, date: 1 }, { unique: true });

offDaySchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.OffDay || mongoose.model('OffDay', offDaySchema);