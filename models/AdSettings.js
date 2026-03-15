const mongoose = require('mongoose');

const AdSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    slotEnabled: {
      HOME_728x90: { type: Boolean, default: true },
      HOME_RIGHT_300x250: { type: Boolean, default: true },
      HOME_RIGHT_RAIL: { type: Boolean, default: true },
      ARTICLE_INLINE: { type: Boolean, default: false },
      ARTICLE_END: { type: Boolean, default: false },
    },
  },
  { timestamps: true, collection: 'ad_settings' },
);

module.exports = mongoose.models.AdSettings || mongoose.model('AdSettings', AdSettingsSchema);
