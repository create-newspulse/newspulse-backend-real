const mongoose = require('mongoose');
const { AD_SLOTS } = require('../lib/ads');

const AdSchema = new mongoose.Schema(
  {
    slot: {
      type: String,
      required: true,
      enum: AD_SLOTS,
      index: true,
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          const s = String(v || '').trim();
          return s.startsWith('https://') || s.startsWith('http://');
        },
        message: 'imageUrl must start with https:// or http://',
      },
    },
    isClickable: {
      type: Boolean,
      default: true,
      index: true,
    },
    targetUrl: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator(v) {
          // If the ad is NOT clickable, allow empty/null targetUrl.
          if (this && this.isClickable === false) return true;

          // If clickable, targetUrl is required and must be valid.
          const s = String(v || '').trim();
          if (!s) return false;
          return s.startsWith('https://') || s.startsWith('http://');
        },
        message: 'targetUrl is required when isClickable=true and must start with https:// or http://',
      },
    },
    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },
    startAt: {
      type: Date,
      default: null,
      index: true,
    },
    endAt: {
      type: Date,
      default: null,
      index: true,
    },
    priority: {
      type: Number,
      default: 0,
      index: true,
    },
    createdBy: {
      type: String,
      default: null,
      trim: true,
    },
    stats: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// Lookup index used by public "active ad" query + sorting.
AdSchema.index(
  { slot: 1, isActive: 1, priority: -1, updatedAt: -1 },
  { name: 'slot_active_priority_updatedAt' },
);

// Supporting indexes for date window filtering.
AdSchema.index({ startAt: 1 }, { name: 'startAt_idx' });
AdSchema.index({ endAt: 1 }, { name: 'endAt_idx' });
AdSchema.index({ priority: -1 }, { name: 'priority_idx' });

module.exports = mongoose.models.Ad || mongoose.model('Ad', AdSchema);
