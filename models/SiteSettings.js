const mongoose = require('mongoose');

const SiteSettingsSchema = new mongoose.Schema(
  {
    liveTvEnabled: { type: Boolean, default: true },
    liveTvUrl: { type: String, default: '' },

    defaultLanguage: { type: String, default: 'en' }, // en / hi / gu
    maintenanceMode: { type: Boolean, default: false },

    brandName: { type: String, default: 'News Pulse' },
  },
  { timestamps: true },
);

module.exports = mongoose.models.SiteSettings || mongoose.model('SiteSettings', SiteSettingsSchema);
