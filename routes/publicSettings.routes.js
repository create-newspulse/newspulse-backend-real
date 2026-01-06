const express = require('express');
const mongoose = require('mongoose');

const SiteSetting = require('../models/SiteSetting');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { defaultPublicSiteSettings, normalizePublicSiteSettings } = require('../lib/publicSiteSettings');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function getOrCreatePublished() {
  const def = defaultPublicSiteSettings();
  if (!isDbReady()) return { published: def, version: 0, updatedAt: null, publishedAt: null, source: 'default' };

  const scope = 'public';
  const key = 'public';

  // Source of truth: singleton PublicSiteSettings document.
  // This is what the admin draft/publish flow writes.
  const singleton = await PublicSiteSettings.findOne({ scope }).lean();
  if (singleton && singleton.published && typeof singleton.published === 'object') {
    return {
      published: normalizePublicSiteSettings(singleton.published) || def,
      version: typeof singleton?.version === 'number' ? singleton.version : 0,
      updatedAt: singleton?.updatedAt || null,
      publishedAt: singleton?.publishedAt || null,
      source: 'db-singleton',
    };
  }

  const doc = await SiteSetting
    .findOne({ scope, key, status: 'published' })
    .sort({ version: -1, createdAt: -1 })
    .lean();

  // Back-compat: older deployments stored the snapshot in PublicSiteSettings.
  // If no SiteSetting has been published yet, serve the legacy published config.
  if (!doc) {
    const legacy = await PublicSiteSettings.findOne({ scope }).lean();
    if (legacy && legacy.published) {
      return {
        published: normalizePublicSiteSettings(legacy.published) || def,
        version: typeof legacy?.version === 'number' ? legacy.version : 0,
        updatedAt: legacy?.updatedAt || null,
        publishedAt: legacy?.publishedAt || null,
        source: 'db-legacy',
      };
    }
  }

  const published = normalizePublicSiteSettings(doc?.data);
  return {
    published: published || def,
    version: typeof doc?.version === 'number' ? doc.version : 0,
    updatedAt: doc?.updatedAt || null,
    publishedAt: doc?.publishedAt || null,
    source: doc ? 'db' : 'default',
  };
}

// GET /api/public/settings
// - No auth
// - Published-only settings
// - No caching so changes show immediately after publish
router.get('/settings', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const { published, version, updatedAt, publishedAt, source } = await getOrCreatePublished();

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      path: req.originalUrl,
      data: published,
      meta: {
        scope: 'public',
        version,
        updatedAt,
        publishedAt,
        source,
      },
    });
  } catch (e) {
    console.error('[public][settings] error', e?.message || e);
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Failed to load public settings',
      data: null,
      path: req.originalUrl,
    });
  }
});

module.exports = router;
