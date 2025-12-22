const mongoose = require('mongoose');

const BroadcastItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['breaking', 'live'],
      index: true,
    },
    text: {
      type: String,
      required: true,
      maxlength: 160,
      trim: true,
    },
    language: {
      type: String,
      enum: ['en', 'hi', 'gu'],
      default: 'en',
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isLive: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// Auto-delete after expiresAt.
BroadcastItemSchema.index({ expiresAt: 1 }, { name: 'expiresAt_ttl', expireAfterSeconds: 0 });

module.exports = mongoose.models.BroadcastItem || mongoose.model('BroadcastItem', BroadcastItemSchema);
