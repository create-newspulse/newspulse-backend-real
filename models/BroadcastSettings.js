const mongoose = require('mongoose');

const BroadcastSettingsSchema = new mongoose.Schema(
  {
    // New Broadcast Center settings shape (preferred)
    breaking: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ['auto', 'force_on', 'force_off'], default: 'auto' },
      speedSec: { type: Number, default: 8, min: 2, max: 30 },
    },
    live: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ['auto', 'force_on', 'force_off'], default: 'auto' },
      speedSec: { type: Number, default: 8, min: 2, max: 30 },
    },

    // Legacy fields used by older routes/UIs (kept for backward compatibility)
    breakingEnabled: { type: Boolean, default: false },
    liveEnabled: { type: Boolean, default: false },
    breakingMode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    liveMode: { type: String, enum: ['manual', 'auto'], default: 'auto' },

    // Single-doc settings record update timestamp.
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

BroadcastSettingsSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  return next();
});

module.exports = mongoose.models.BroadcastSettings || mongoose.model('BroadcastSettings', BroadcastSettingsSchema);
