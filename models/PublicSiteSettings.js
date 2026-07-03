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
    mode: 'Offline Replay',
    provider: 'YouTube',
    embedUrl: '',
    fallbackVideoUrl: '',
    title: 'News Pulse Live',
    subtitle: '',
    language: 'English',
    showOnHomepage: true,
  },
  dailyWonders: {
    enabled: true,
    showOnHomepage: true,
    label: 'DAILY WONDERS',
    title: 'Thought of the Day',
    subtitle: 'One meaningful thought to pause, reflect, and move through the day with clarity.',
    thoughtLabel: "TODAY'S THOUGHT",
    thoughtText: 'A peaceful mind does not come from a perfect day, but from choosing calm in the middle of it.',
    reminderLabel: 'GENTLE REMINDER',
    reminderText: 'You do not need to solve the whole day at once. One honest step is enough.',
    footerText: 'A small daily pause for calm, clarity, and inspiration.',
  },
  // Language & Theme configuration
  languageTheme: {
    languages: ['en', 'hi', 'gu'],
    themePreset: 'default',
  },
};

const PublicSiteSettingsSchema = new mongoose.Schema(
  {
    // Scope/namespace so dev/staging/prod can coexist safely even if they share a DB.
    // Defaults to production for legacy compatibility.
    scope: {
      type: String,
      default: 'production',
    },
    version: {
      type: Number,
      default: 1,
    },
    publishedUpdatedAt: {
      type: Date,
      default: () => new Date(),
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

function _desiredScopeFromEnv() {
  const explicit = String(process.env.PUBLIC_SITE_SETTINGS_SCOPE || '').trim();
  if (explicit) return explicit;

  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  return env === 'production' ? 'production' : 'development';
}

// Static method to get or create settings with defaults
PublicSiteSettingsSchema.statics.getOrCreate = async function (opts = {}) {
  const desiredScope = String(opts.scope || _desiredScopeFromEnv()).trim() || 'development';

  // Production compatibility:
  // - If an older doc exists with no scope, treat it as production and backfill scope.
  const query = desiredScope === 'production'
    ? { $or: [{ scope: 'production' }, { scope: { $exists: false } }] }
    : { scope: desiredScope };

  let settings = await this.findOne(query).sort({ updatedAt: -1, createdAt: -1 });
  if (!settings) {
    settings = await this.create({
      scope: desiredScope,
      version: 1,
      publishedUpdatedAt: new Date(),
      draft: null,
      published: JSON.parse(JSON.stringify(defaultSettings)),
    });
  } else if (typeof settings.version !== 'number') {
    // Backfill for older documents created before version existed
    settings.version = 1;
    await settings.save();
  }

  // Backfill scope for older documents (especially important for production).
  if (!settings.scope) {
    settings.scope = desiredScope === 'production' ? 'production' : desiredScope;
    await settings.save();
  }

  // Backfill publishedUpdatedAt for older documents
  if (!settings.publishedUpdatedAt) {
    settings.publishedUpdatedAt = settings.updatedAt || settings.createdAt || new Date();
    await settings.save();
  }
  return settings;
};

// Export default settings for use in controllers
PublicSiteSettingsSchema.statics.getDefaultSettings = function () {
  return JSON.parse(JSON.stringify(defaultSettings));
};

module.exports = mongoose.models.PublicSiteSettings || mongoose.model('PublicSiteSettings', PublicSiteSettingsSchema);
