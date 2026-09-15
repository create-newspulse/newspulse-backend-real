const mongoose = require('mongoose');
const { AD_SLOTS } = require('../lib/ads');

const adPerformanceDailySchema = new mongoose.Schema(
  {
    adId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true, index: true },
    dateKey: { type: String, required: true, index: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    slot: { type: String, required: true, enum: AD_SLOTS, index: true, trim: true },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true },
);

adPerformanceDailySchema.index({ adId: 1, dateKey: 1 }, { unique: true, name: 'adId_dateKey_unique' });
adPerformanceDailySchema.index({ dateKey: 1, slot: 1 }, { name: 'dateKey_slot_idx' });
adPerformanceDailySchema.index({ slot: 1, dateKey: 1 }, { name: 'slot_dateKey_idx' });

module.exports = mongoose.models.AdPerformanceDaily || mongoose.model('AdPerformanceDaily', adPerformanceDailySchema);