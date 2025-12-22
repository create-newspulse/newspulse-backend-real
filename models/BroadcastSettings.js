const mongoose = require('mongoose');

const BroadcastSettingsSchema = new mongoose.Schema(
  {
    breakingEnabled: { type: Boolean, default: false },
    liveEnabled: { type: Boolean, default: false },
    breakingMode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    liveMode: { type: String, enum: ['manual', 'auto'], default: 'auto' },

    // Single-doc settings record update timestamp.
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

module.exports = mongoose.models.BroadcastSettings || mongoose.model('BroadcastSettings', BroadcastSettingsSchema);
