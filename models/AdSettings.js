const mongoose = require('mongoose');

const { buildSlotEnabledDefaults } = require('../src/constants/adSlots');

const AdSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    slotEnabled: {
      type: Map,
      of: Boolean,
      default: () => buildSlotEnabledDefaults(true, {
        HOME_RIGHT_300x600: false,
        HOME_BILLBOARD_970x250: false,
      }),
    },
  },
  { timestamps: true, collection: 'ad_settings' },
);

module.exports = mongoose.models.AdSettings || mongoose.model('AdSettings', AdSettingsSchema);
