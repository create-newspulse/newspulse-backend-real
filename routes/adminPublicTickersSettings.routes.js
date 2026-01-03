const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const SiteSetting = require('../models/SiteSetting');
const BroadcastSettings = require('../models/BroadcastSettings');
const { DEFAULT_TICKERS_CONFIG, TickersConfigSchema } = require('../schemas/tickersConfig.schema');

const router = express.Router();

const SCOPE = 'public';
const KEY = 'tickers';

function isDbConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function shouldUseBroadcastAlias(req) {
  // Keep legacy /admin/* behavior intact (draft/publish versions backed by SiteSetting).
  // Use BroadcastSettings for /api/admin/* (and admin-api proxy mounts) to support
  // backward-compatible aliases during the transition to Broadcast Center.
  return String(req.baseUrl || '') !== '/admin';
}

async function getOrCreateBroadcastSettings() {
  let doc = await BroadcastSettings.findOne({});
  if (!doc) {
    try {
      doc = await BroadcastSettings.create({});
    } catch (_) {
      doc = await BroadcastSettings.findOne({});
    }
  }
  return doc;
}

function tickersConfigFromBroadcastSettings(doc) {
  const def = DEFAULT_TICKERS_CONFIG;
  const breakingDoc = doc && doc.breaking ? doc.breaking : {};
  const liveDoc = doc && doc.live ? doc.live : {};

  let breakingMode = typeof breakingDoc.mode === 'string' ? breakingDoc.mode : undefined;
  if (!breakingMode) {
    if (breakingDoc.enabled === false) breakingMode = 'off';
    else breakingMode = def.tickers.breaking.mode;
  }
  if (breakingMode !== 'auto' && breakingMode !== 'force_on' && breakingMode !== 'off') {
    breakingMode = def.tickers.breaking.mode;
  }

  const showOn = Array.isArray(liveDoc.showOn) ? liveDoc.showOn : def.tickers.live.showOn;

  return {
    tickers: {
      live: {
        enabled: typeof liveDoc.enabled === 'boolean' ? liveDoc.enabled : def.tickers.live.enabled,
        speedSec: typeof liveDoc.speedSec === 'number' ? liveDoc.speedSec : def.tickers.live.speedSec,
        refreshSec:
          typeof liveDoc.refreshIntervalSec === 'number'
            ? liveDoc.refreshIntervalSec
            : def.tickers.live.refreshSec,
        maxItems: typeof liveDoc.maxItems === 'number' ? liveDoc.maxItems : def.tickers.live.maxItems,
        showOn,
        placeholder: def.tickers.live.placeholder,
      },
      breaking: {
        mode: breakingMode,
        showWhenEmpty:
          typeof breakingDoc.showWhenEmpty === 'boolean'
            ? breakingDoc.showWhenEmpty
            : def.tickers.breaking.showWhenEmpty,
        speedSec: typeof breakingDoc.speedSec === 'number' ? breakingDoc.speedSec : def.tickers.breaking.speedSec,
        freshnessMinutes:
          typeof breakingDoc.freshnessMin === 'number'
            ? breakingDoc.freshnessMin
            : def.tickers.breaking.freshnessMinutes,
        maxItems: typeof breakingDoc.maxItems === 'number' ? breakingDoc.maxItems : def.tickers.breaking.maxItems,
        placeholder: def.tickers.breaking.placeholder,
      },
    },
  };
}

async function saveBroadcastSettingsFromTickersConfig(config) {
  const live = config && config.tickers ? config.tickers.live : null;
  const breaking = config && config.tickers ? config.tickers.breaking : null;

  const update = {
    updatedAt: new Date(),
  };

  if (breaking) {
    update.breaking = {
      enabled: breaking.mode !== 'off',
      mode: breaking.mode,
      showWhenEmpty: breaking.showWhenEmpty,
      speedSec: breaking.speedSec,
      freshnessMin: breaking.freshnessMinutes,
      maxItems: breaking.maxItems,
    };
  }

  if (live) {
    update.live = {
      enabled: live.enabled,
      speedSec: live.speedSec,
      refreshIntervalSec: live.refreshSec,
      maxItems: live.maxItems,
      showOn: live.showOn,
    };
  }

  const doc = await BroadcastSettings.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
  return doc;
}

function getPreviewSecret() {
  return String(process.env.UI_PREVIEW_SECRET || '').trim();
}

function formatZodError(zodError) {
  try {
    return (zodError.issues || []).map(i => ({ path: i.path, message: i.message }));
  } catch (_) {
    return [{ path: [], message: 'Invalid payload' }];
  }
}

// Admin panel legacy paths are /admin/settings/tickers*.
// The newer API paths are /api/admin/public-settings/tickers*.
const ADMIN_PATHS = {
  base: ['/public-settings/tickers', '/settings/tickers', '/tickers'],
  draft: ['/public-settings/tickers/draft', '/settings/tickers/draft', '/tickers/draft'],
  publish: ['/public-settings/tickers/publish', '/settings/tickers/publish', '/tickers/publish'],
  versions: ['/public-settings/tickers/versions', '/settings/tickers/versions', '/tickers/versions'],
  previewToken: ['/public-settings/tickers/preview-token', '/settings/tickers/preview-token', '/tickers/preview-token'],
};

// Some admin builds call GET /api/admin/tickers/draft (path param) instead of
// GET /api/admin/tickers?status=draft (query param).
// Provide an explicit GET route so /draft can never be interpreted as an id-like segment.
router.get(ADMIN_PATHS.draft, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(200).json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, setting: null, message: 'Database unavailable' });
    }

    if (shouldUseBroadcastAlias(req)) {
      const doc = await getOrCreateBroadcastSettings();
      const data = tickersConfigFromBroadcastSettings(doc);
      return res.json({
        ok: true,
        success: true,
        status: 200,
        scope: SCOPE,
        key: KEY,
        setting: {
          _id: 'broadcast-settings',
          scope: SCOPE,
          key: KEY,
          status: 'draft',
          data,
          updatedAt: doc?.updatedAt || null,
        },
        source: 'broadcast',
      });
    }

    const doc = await SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'draft' });
    return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, setting: doc || null });
  } catch (e) {
    return next(e);
  }
});

// GET /api/admin/public-settings/tickers?status=draft|published
router.get(ADMIN_PATHS.base, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(200).json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, setting: null, message: 'Database unavailable' });
    }

    const status = String(req.query.status || '').trim().toLowerCase();
    if (status !== 'draft' && status !== 'published') {
      return res.status(400).json({ ok: false, success: false, message: 'status must be draft|published' });
    }

    if (shouldUseBroadcastAlias(req)) {
      const doc = await getOrCreateBroadcastSettings();
      const data = tickersConfigFromBroadcastSettings(doc);
      return res.json({
        ok: true,
        success: true,
        status: 200,
        scope: SCOPE,
        key: KEY,
        setting: {
          _id: 'broadcast-settings',
          scope: SCOPE,
          key: KEY,
          status,
          data,
          updatedAt: doc?.updatedAt || null,
        },
        source: 'broadcast',
      });
    }

    if (status === 'draft') {
      const doc = await SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'draft' });
      return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, setting: doc || null });
    }

    const doc = await SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'published' }).sort({ version: -1, createdAt: -1 });
    return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, setting: doc || null });
  } catch (e) {
    return next(e);
  }
});

// PUT /api/admin/public-settings/tickers?status=draft
// Some admin panel builds autosave via PUT to the base path rather than /draft.
router.put(ADMIN_PATHS.base, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ ok: false, success: false, status: 503, message: 'Database unavailable' });
    }

    const status = String(req.query.status || 'draft').trim().toLowerCase();
    if (status !== 'draft') {
      return res.status(400).json({ ok: false, success: false, message: 'Only status=draft is supported for PUT; use /public-settings/tickers/publish to publish' });
    }

    const parsed = TickersConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid tickers config', issues: formatZodError(parsed.error) });
    }

    if (shouldUseBroadcastAlias(req)) {
      const doc = await saveBroadcastSettingsFromTickersConfig(parsed.data);
      return res.json({
        ok: true,
        success: true,
        status: 200,
        setting: {
          _id: 'broadcast-settings',
          scope: SCOPE,
          key: KEY,
          status: 'draft',
          data: tickersConfigFromBroadcastSettings(doc),
          updatedAt: doc?.updatedAt || null,
        },
        source: 'broadcast',
      });
    }

    const admin = req.admin || {};
    const update = {
      scope: SCOPE,
      key: KEY,
      status: 'draft',
      data: parsed.data,
      createdBy: { id: admin.id, email: admin.email },
    };

    const doc = await SiteSetting.findOneAndUpdate(
      { scope: SCOPE, key: KEY, status: 'draft' },
      { $set: update },
      { upsert: true, new: true },
    );

    return res.json({ ok: true, success: true, status: 200, setting: doc });
  } catch (e) {
    return next(e);
  }
});

// PUT /api/admin/public-settings/tickers/draft (autosave)
router.put(ADMIN_PATHS.draft, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ ok: false, success: false, status: 503, message: 'Database unavailable' });
    }

    const parsed = TickersConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid tickers config', issues: formatZodError(parsed.error) });
    }

    if (shouldUseBroadcastAlias(req)) {
      const doc = await saveBroadcastSettingsFromTickersConfig(parsed.data);
      return res.json({
        ok: true,
        success: true,
        status: 200,
        setting: {
          _id: 'broadcast-settings',
          scope: SCOPE,
          key: KEY,
          status: 'draft',
          data: tickersConfigFromBroadcastSettings(doc),
          updatedAt: doc?.updatedAt || null,
        },
        source: 'broadcast',
      });
    }

    const admin = req.admin || {};
    const update = {
      scope: SCOPE,
      key: KEY,
      status: 'draft',
      data: parsed.data,
      createdBy: { id: admin.id, email: admin.email },
    };

    const doc = await SiteSetting.findOneAndUpdate(
      { scope: SCOPE, key: KEY, status: 'draft' },
      { $set: update },
      { upsert: true, new: true },
    );

    return res.json({ ok: true, success: true, status: 200, setting: doc });
  } catch (e) {
    return next(e);
  }
});

// POST /api/admin/public-settings/tickers/publish (snapshot)
router.post(ADMIN_PATHS.publish, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ ok: false, success: false, status: 503, message: 'Database unavailable' });
    }

    if (shouldUseBroadcastAlias(req)) {
      // BroadcastSettings is a single document (no draft/published versions).
      // For compatibility with older admin UIs, treat publish as a no-op success.
      const doc = await getOrCreateBroadcastSettings();
      return res.json({
        ok: true,
        success: true,
        status: 200,
        setting: {
          _id: 'broadcast-settings',
          scope: SCOPE,
          key: KEY,
          status: 'published',
          version: 1,
          data: tickersConfigFromBroadcastSettings(doc),
          publishedAt: new Date(),
          updatedAt: doc?.updatedAt || null,
        },
        source: 'broadcast',
      });
    }

    const draft = await SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'draft' });
    if (!draft || !draft.data) {
      return res.status(400).json({ ok: false, success: false, message: 'No draft exists to publish' });
    }

    const parsed = TickersConfigSchema.safeParse(draft.data);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Draft tickers config is invalid', issues: formatZodError(parsed.error) });
    }

    const latest = await SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'published' }).sort({ version: -1, createdAt: -1 });
    const nextVersion = (latest && typeof latest.version === 'number' ? latest.version : 0) + 1;

    const admin = req.admin || {};
    const published = await SiteSetting.create({
      scope: SCOPE,
      key: KEY,
      status: 'published',
      version: nextVersion,
      data: parsed.data,
      publishedAt: new Date(),
      publishedBy: { id: admin.id, email: admin.email },
      createdBy: draft.createdBy || { id: admin.id, email: admin.email },
    });

    // Note: return HTTP 200 for compatibility with existing admin UI expectations.
    return res.json({ ok: true, success: true, status: 200, setting: published });
  } catch (e) {
    return next(e);
  }
});

// GET /api/admin/public-settings/tickers/versions (latest 30)
router.get(ADMIN_PATHS.versions, requireAdminAuth, async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(200).json({ ok: true, success: true, status: 200, items: [], message: 'Database unavailable' });
    }

    if (shouldUseBroadcastAlias(req)) {
      // No versions for single-doc BroadcastSettings.
      return res.json({ ok: true, success: true, status: 200, items: [] });
    }

    const docs = await SiteSetting.find({ scope: SCOPE, key: KEY, status: 'published' })
      .sort({ version: -1, createdAt: -1 })
      .limit(30);

    return res.json({ ok: true, success: true, status: 200, items: docs });
  } catch (e) {
    return next(e);
  }
});

// POST /api/admin/public-settings/tickers/preview-token (15m JWT)
router.post(ADMIN_PATHS.previewToken, requireAdminAuth, async (req, res, next) => {
  try {
    const secret = getPreviewSecret();
    if (!secret) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'UI_PREVIEW_SECRET missing' });
    }

    const admin = req.admin || {};
    const token = jwt.sign(
      {
        type: 'ui_preview',
        scope: SCOPE,
        key: KEY,
        sub: admin.id || 'admin',
        email: admin.email || undefined,
      },
      secret,
      { expiresIn: '15m' },
    );

    return res.json({ ok: true, success: true, status: 200, token, expiresInSeconds: 15 * 60 });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

/*
Curl examples:

# Save draft
curl -X PUT "http://localhost:5000/api/admin/public-settings/tickers/draft" \
  -H "Content-Type: application/json" \
  -H "Cookie: np_admin=admin@newspulse.ai" \
  -d '{"tickers":{"live":{"enabled":true,"speedSec":20,"refreshSec":60,"maxItems":10,"showOn":["home"],"placeholder":"Live"},"breaking":{"mode":"auto","showWhenEmpty":false,"speedSec":18,"freshnessMinutes":120,"maxItems":10,"placeholder":"Breaking"}}}'

# Publish latest draft as a new version
curl -X POST "http://localhost:5000/api/admin/public-settings/tickers/publish" \
  -H "Cookie: np_admin=admin@newspulse.ai"

# Generate preview token
curl -X POST "http://localhost:5000/api/admin/public-settings/tickers/preview-token" \
  -H "Cookie: np_admin=admin@newspulse.ai"
*/
