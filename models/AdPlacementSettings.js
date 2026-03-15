const mongoose = require('mongoose');

const { buildSlotEnabledDefaults } = require('../src/constants/adSlots');

const AdPlacementSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },
    slotEnabled: {
      type: Map,
      of: Boolean,
      default: () => buildSlotEnabledDefaults(true),
    },
  },
  { timestamps: true, collection: 'ad_placement_settings' },
);

module.exports = mongoose.models.AdPlacementSettings || mongoose.model('AdPlacementSettings', AdPlacementSettingsSchema);
