const mongoose = require('mongoose');

const BroadcastSettingsSchema = new mongoose.Schema(
  {
    // New Broadcast Center settings shape (preferred)
    breaking: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ['auto', 'force_on', 'force_off'], default: 'auto' },
      // Canonical per-channel ticker speed for admin panel (seconds)
      tickerSpeedSeconds: { type: Number, default: 8, min: 4, max: 60 },
      // Back-compat mirror used by older endpoints
      speedSec: { type: Number, default: 8, min: 2, max: 120 },
    },
    live: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ['auto', 'force_on', 'force_off'], default: 'auto' },
      tickerSpeedSeconds: { type: Number, default: 8, min: 4, max: 60 },
      speedSec: { type: Number, default: 8, min: 2, max: 120 },
    },

    // Legacy fields used by older routes/UIs (kept for backward compatibility)
    breakingEnabled: { type: Boolean, default: false },
    liveEnabled: { type: Boolean, default: false },
    // Phase 1: explicit per-channel duration (seconds) used by tickers UI.
    // (Kept separate from public site/homepage settings.)
    breakingDurationSeconds: { type: Number, default: 8, min: 2, max: 120 },
    liveDurationSeconds: { type: Number, default: 8, min: 2, max: 120 },
    breakingMode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    liveMode: { type: String, enum: ['manual', 'auto'], default: 'auto' },

    // Single-doc settings record update timestamp.
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

BroadcastSettingsSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();

  // Keep speedSec mirrored from tickerSpeedSeconds (older consumers read speedSec).
  try {
    const b = this.breaking || {};
    const l = this.live || {};
    if (typeof b.tickerSpeedSeconds === 'number' && Number.isFinite(b.tickerSpeedSeconds)) {
      this.breaking.speedSec = b.tickerSpeedSeconds;
      this.breakingDurationSeconds = b.tickerSpeedSeconds;
    }
    if (typeof l.tickerSpeedSeconds === 'number' && Number.isFinite(l.tickerSpeedSeconds)) {
      this.live.speedSec = l.tickerSpeedSeconds;
      this.liveDurationSeconds = l.tickerSpeedSeconds;
    }

    // Keep legacy enabled mirrors aligned.
    this.breakingEnabled = Boolean(this.breaking && this.breaking.enabled);
    this.liveEnabled = Boolean(this.live && this.live.enabled);
  } catch (_) {}

  return next();
});

module.exports = mongoose.models.BroadcastSettings || mongoose.model('BroadcastSettings', BroadcastSettingsSchema);
