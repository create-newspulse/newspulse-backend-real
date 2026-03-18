const mongoose = require('mongoose');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ensureCategoryStripEnabled(settingsObj) {
  const base = (settingsObj && typeof settingsObj === 'object') ? settingsObj : {};
  if (!base.publicSite || typeof base.publicSite !== 'object') base.publicSite = {};
  if (!base.publicSite.homepage || typeof base.publicSite.homepage !== 'object') base.publicSite.homepage = {};
  if (typeof base.publicSite.homepage.categoryStripEnabled !== 'boolean') {
    base.publicSite.homepage.categoryStripEnabled = true;
  }

  // Backward/forward-compat normalization for homepage modules and tickers.
  // Different frontend builds have used different key names over time.
  if (!base.homepage || typeof base.homepage !== 'object') base.homepage = {};
  if (!base.homepage.modules || typeof base.homepage.modules !== 'object') base.homepage.modules = {};
  const modules = base.homepage.modules;

  // trendingStrip <-> trending
  if (modules.trending && !modules.trendingStrip) modules.trendingStrip = modules.trending;
  if (modules.trendingStrip && !modules.trending) modules.trending = modules.trendingStrip;

  // exploreCategories <-> explore
  if (modules.explore && !modules.exploreCategories) modules.exploreCategories = modules.explore;
  if (modules.exploreCategories && !modules.explore) modules.explore = modules.exploreCategories;

  // liveTvCard <-> liveTv
  if (modules.liveTv && !modules.liveTvCard) modules.liveTvCard = modules.liveTv;
  if (modules.liveTvCard && !modules.liveTv) modules.liveTv = modules.liveTvCard;

  // Ensure tickers object exists and normalize speed field names.
  if (!base.tickers || typeof base.tickers !== 'object') base.tickers = {};
  for (const k of ['breaking', 'live']) {
    if (!base.tickers[k] || typeof base.tickers[k] !== 'object') continue;
    const t = base.tickers[k];
    if (t.speedSec !== undefined && t.speedSeconds === undefined) t.speedSeconds = t.speedSec;
    if (t.speedSeconds !== undefined && t.speedSec === undefined) t.speedSec = t.speedSeconds;
  }

  return base;
}

function deepMerge(target, source) {
  const t = (target && typeof target === 'object') ? target : {};
  const s = (source && typeof source === 'object') ? source : {};
  for (const [key, value] of Object.entries(s)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      t[key] = deepMerge(t[key], value);
    } else {
      t[key] = value;
    }
  }
  return t;
}

function getNested(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return { exists: false, value: undefined };
    cur = cur[p];
  }
  return { exists: true, value: cur };
}

/**
 * Get both draft and published settings
 * GET /api/admin/settings/public
 */
async function getPublicSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
    const published = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      draft,
      published,
    });
  } catch (error) {
    console.error('[getPublicSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch public settings',
      error: error.message,
    });
  }
}

/**
 * Get draft settings only
 * GET /api/admin/settings/public/draft
 */
async function getDraftSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      draft,
    });
  } catch (error) {
    console.error('[getDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch draft settings',
      error: error.message,
    });
  }
}

/**
 * Update draft settings
 * PUT /api/admin/settings/public/draft
 */
async function updateDraftSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const draftData = req.body;

    if (!draftData || typeof draftData !== 'object') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid draft data: expected an object',
      });
    }

    // Strict validation for Category Strip flag if present
    const cs = getNested(draftData, 'publicSite.homepage.categoryStripEnabled');
    if (cs.exists && typeof cs.value !== 'boolean') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid value for publicSite.homepage.categoryStripEnabled: expected boolean',
      });
    }

    const settings = await PublicSiteSettings.getOrCreate();

    // Merge into existing draft to support partial updates without clobbering other keys
    const baseDraft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
    const merged = deepMerge(baseDraft, draftData);
    settings.draft = ensureCategoryStripEnabled(merged);
    await settings.save();

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      draft: settings.draft,
      message: 'Draft settings saved successfully',
    });
  } catch (error) {
    console.error('[updateDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to update draft settings',
      error: error.message,
    });
  }
}

/**
 * Publish draft settings (copy draft to published)
 * POST /api/admin/settings/public/publish
 */
async function publishSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();

    // Ensure a numeric version exists
    if (typeof settings.version !== 'number') settings.version = 1;

    // If no draft exists, publish current published or defaults
    if (!settings.draft || Object.keys(settings.draft).length === 0) {
      const currentPublished = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());
      settings.published = currentPublished;
    } else {
      // Copy draft to published
      settings.published = ensureCategoryStripEnabled(JSON.parse(JSON.stringify(settings.draft)));
    }

    // Bump version as part of the publish operation
    settings.version = settings.version + 1;
    settings.publishedUpdatedAt = new Date();
    await settings.save();

    bumpPublicConfigVersion().catch(() => {});

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: settings.version,
      updatedAt: settings.publishedUpdatedAt
        ? new Date(settings.publishedUpdatedAt).toISOString()
        : (settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString()),
      published: settings.published,
      message: 'Settings published successfully',
    });
  } catch (error) {
    console.error('[publishSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to publish settings',
      error: error.message,
    });
  }
}

/**
 * Save public settings (admin)
 * PATCH /api/admin/settings/public  -> merge into draft
 * PUT   /api/admin/settings/public  -> replace draft
 */
async function savePublicSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const newData = req.body;
    if (!newData || typeof newData !== 'object') {
      return res.status(400).json({ ok: false, message: 'Invalid settings payload: expected object' });
    }

    const settings = await PublicSiteSettings.getOrCreate();
    const baseDraft = settings.draft || PublicSiteSettings.getDefaultSettings();
    const basePublished = settings.published || PublicSiteSettings.getDefaultSettings();

    // Validate types for fields that exist in current settings (booleans/numbers)
    function _validate(obj, pathParts = []) {
      for (const [k, v] of Object.entries(obj)) {
        const parts = pathParts.concat(k);
        const path = parts.join('.');
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const err = _validate(v, parts);
          if (err) return err;
          continue;
        }

        const existing = getNested(baseDraft, path);
        const existingPub = getNested(basePublished, path);
        const existingVal = existing.exists ? existing.value : (existingPub.exists ? existingPub.value : undefined);

        if (existingVal !== undefined) {
          if (typeof existingVal === 'boolean' && typeof v !== 'boolean') {
            return { ok: false, message: `Invalid type for ${path}: expected boolean` };
          }
          if (typeof existingVal === 'number' && typeof v !== 'number') {
            return { ok: false, message: `Invalid type for ${path}: expected number` };
          }
        }
      }
      return null;
    }

    const validationErr = _validate(newData);
    if (validationErr) return res.status(400).json(validationErr);

    if (String(req.method || '').toUpperCase() === 'PUT') {
      // Replace draft entirely
      settings.draft = ensureCategoryStripEnabled(newData);
    } else {
      // PATCH -> merge into existing draft
      const merged = deepMerge(ensureCategoryStripEnabled(baseDraft), newData);
      settings.draft = ensureCategoryStripEnabled(merged);
    }

    await settings.save();

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      draft: settings.draft,
      published: settings.published,
    });
  } catch (error) {
    console.error('[savePublicSettings] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to save public settings', error: error.message });
  }
}

/**
 * Get published settings (public endpoint, no auth)
 * GET /api/public/settings
 */
async function getPublishedSettings(req, res) {
  try {
    // Public endpoint should stay stable even if DB is down.
    if (!isDbReady()) {
      const fallback = ensureCategoryStripEnabled(PublicSiteSettings.getDefaultSettings());
      res.set('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({
        ok: true,
        scope: String(process.env.PUBLIC_SITE_SETTINGS_SCOPE || '').trim() || (String(process.env.NODE_ENV || 'development').toLowerCase() === 'production' ? 'production' : 'development'),
        version: 1,
        updatedAt: new Date().toISOString(),
        published: fallback,
      });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const published = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());

    res.set('Cache-Control', 'no-store, max-age=0');

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.publishedUpdatedAt
        ? new Date(settings.publishedUpdatedAt).toISOString()
        : (settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString()),
      published,
    });
  } catch (error) {
    console.error('[getPublishedSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch published settings',
      error: error.message,
    });
  }
}

module.exports = {
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
  savePublicSettings,
  getPublishedSettings,
};
