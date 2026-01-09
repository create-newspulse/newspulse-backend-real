const mongoose = require('mongoose');

// Default settings matching frontend module expectations
const defaultSettings = {
  // Public-site safe settings (consumed by frontend)
  publicSite: {
    homepage: {
      // Top horizontal categories bar
      categoryStripEnabled: true,
    },
  },
  // Homepage modules configuration
  homepage: {
    modules: {
      categoryStrip: { enabled: true, order: 1 },
      trendingStrip: { enabled: true, order: 2 },
      exploreCategories: { enabled: true, order: 3 },
      liveTvCard: { enabled: true, order: 4 },
      quickTools: { enabled: true, order: 5 },
      snapshots: { enabled: true, order: 6 },
      appPromo: { enabled: true, order: 7 },
      footer: { enabled: true, order: 8 },
    },
  },
  // Tickers configuration
  tickers: {
    breaking: {
      enabled: true,
      speedSeconds: 30,
      showWhenEmpty: false,
      mode: 'auto', // auto, demo, off
    },
    live: {
      enabled: true,
      speedSeconds: 25,
    },
  },
  // Live TV configuration
  liveTv: {
    enabled: true,
    embedUrl: '',
  },
  // Language & Theme configuration
  languageTheme: {
    languages: ['en', 'hi', 'gu'],
    themePreset: 'default',
  },
};

const PublicSiteSettingsSchema = new mongoose.Schema(
  {
    version: {
      type: Number,
      default: 1,
    },
    draft: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    published: {
      type: mongoose.Schema.Types.Mixed,
      default: () => JSON.parse(JSON.stringify(defaultSettings)),
    },
  },
  { timestamps: true }
);

// Static method to get or create settings with defaults
PublicSiteSettingsSchema.statics.getOrCreate = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({
      version: 1,
      draft: null,
      published: JSON.parse(JSON.stringify(defaultSettings)),
    });
  } else if (typeof settings.version !== 'number') {
    // Backfill for older documents created before version existed
    settings.version = 1;
    await settings.save();
  }
  return settings;
};

// Export default settings for use in controllers
PublicSiteSettingsSchema.statics.getDefaultSettings = function () {
  return JSON.parse(JSON.stringify(defaultSettings));
};

module.exports = mongoose.models.PublicSiteSettings || mongoose.model('PublicSiteSettings', PublicSiteSettingsSchema);
