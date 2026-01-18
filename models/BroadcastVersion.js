const mongoose = require('mongoose');

const BroadcastVersionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    version: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

BroadcastVersionSchema.pre('save', function onSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.BroadcastVersion || mongoose.model('BroadcastVersion', BroadcastVersionSchema);
