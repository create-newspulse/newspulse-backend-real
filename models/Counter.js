const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true, index: true },
  value: { type: Number, required: true, default: 0, min: 0 },
  updatedAt: { type: Date, default: Date.now },
});

counterSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);