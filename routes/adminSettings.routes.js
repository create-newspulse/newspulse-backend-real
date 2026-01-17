const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAuth, requireFounder } = require('../middleware/requireAuth');
const SystemSetting = require('../models/SystemSetting');

const router = express.Router();

function hasPermission(req, perm) {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'founder') return true;
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  return permissions.includes(perm);
}

function requireFounderOrPermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, success: false, status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    if (!hasPermission(req, perm)) return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    return next();
  };
}

const AnyObjectSchema = z.record(z.any());

const ADMIN_SETTINGS_KEY = 'settings_center_admin';
const PUBLIC_SETTINGS_KEY = 'settings_center_public';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function dbStatusPayload() {
  const readyState = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  const connected = readyState === 1;
  const name = connected && mongoose?.connection?.name ? String(mongoose.connection.name) : null;
  return {
    connected,
    readyState,
    ...(name ? { name } : {}),
  };
}

function defaultAdminSettings() {
  return {
    // Keep the legacy placeholder key so older UIs don't break.
    sections: {},
    // Newer UIs can use this.
    adminPanel: {},
  };
}

function defaultAdminPanelPayload() {
  return {};
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(...objs) {
  const out = {};
  for (const src of objs) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else if (isPlainObject(v)) {
        out[k] = deepMerge(v);
      } else if (Array.isArray(v)) {
        out[k] = v.slice();
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function extractAdminPanelDraftPublished(settingsValue) {
  const root = settingsValue && typeof settingsValue === 'object' ? settingsValue : {};
  const ap = root.adminPanel && typeof root.adminPanel === 'object' ? root.adminPanel : null;

  const draft = (ap && ap.draft && typeof ap.draft === 'object') ? ap.draft : (root.adminPanelDraft || null);
  const published = (ap && ap.published && typeof ap.published === 'object') ? ap.published : (root.adminPanelPublished || null);

  // If adminPanel is a flat object, treat it as published.
  const fallbackPublished = (ap && !ap.draft && !ap.published && typeof ap === 'object') ? ap : {};

  return {
    draft: (draft && typeof draft === 'object') ? draft : {},
    published: (published && typeof published === 'object') ? published : fallbackPublished,
  };
}

function resolveAdminPanelPayloadForState(settingsValue, state) {
  const root = settingsValue && typeof settingsValue === 'object' ? settingsValue : {};
  const ap = root.adminPanel && typeof root.adminPanel === 'object' ? root.adminPanel : null;

  // Supported shapes:
  // - { adminPanel: { draft: {...}, published: {...}, version? } }
  // - { adminPanelDraft: {...}, adminPanelPublished: {...} }
  // - { adminPanel: {...} } (treat as published/effective)
  const draft = (ap && ap.draft && typeof ap.draft === 'object') ? ap.draft : (root.adminPanelDraft || null);
  const published = (ap && ap.published && typeof ap.published === 'object') ? ap.published : (root.adminPanelPublished || null);

  if (state === 'draft') return draft && typeof draft === 'object' ? draft : (ap || defaultAdminPanelPayload());
  if (state === 'published') return published && typeof published === 'object' ? published : (ap || defaultAdminPanelPayload());

  // effective: defaults + published (no mutation)
  const base = defaultAdminPanelPayload();
  const pub = published && typeof published === 'object' ? published : (ap || {});
  return { ...base, ...pub };
}

function defaultPublicSettings() {
  return {
    publicSite: {
      homeModules: {},
      liveTV: {},
      footer: {},
    },
  };
}

async function readSetting(key, fallbackValue) {
  if (!isDbReady()) {
    return { value: fallbackValue, updatedAt: null, source: 'default' };
  }

  const doc = await SystemSetting.findOne({ key }).lean();
  if (!doc || typeof doc.value !== 'object' || doc.value === null) {
    return { value: fallbackValue, updatedAt: null, source: 'default' };
  }

  return { value: doc.value, updatedAt: doc.updatedAt || null, source: 'db' };
}

async function writeSetting(key, value, admin) {
  if (!isDbReady()) {
    return { ok: false, status: 503, message: 'DB unavailable' };
  }

  const updatedBy = {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };

  const doc = await SystemSetting.findOneAndUpdate(
    { key },
    { $set: { key, value, updatedBy } },
    { upsert: true, new: true },
  ).lean();

  return { ok: true, status: 200, updatedAt: doc?.updatedAt || null };
}

// GET /api/admin/settings
router.get('/settings', requireAdminAuth, async (_req, res, next) => {
  try {
    const fallback = defaultAdminSettings();
    const db = dbStatusPayload();

    if (!db.connected) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'DB unavailable',
        data: fallback,
        updatedAt: null,
        db,
      });
    }

    const { value, updatedAt } = await readSetting(ADMIN_SETTINGS_KEY, fallback);
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      data: value,
      updatedAt,
      db,
    });
  } catch (e) {
    console.error('[ADMIN_SETTINGS][get] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: _req.originalUrl,
    });
  }
});

// GET /api/admin/settings/admin-panel/preview?state=draft|published|effective
// Read-only preview endpoint used by Admin Panel Settings → Preview tab.
router.get('/settings/admin-panel/preview', requireAuth, requireFounderOrPermission('settings.read'), async (req, res, next) => {
  try {
    const stateRaw = String(req.query.state || 'effective').toLowerCase();
    const allowed = new Set(['draft', 'published', 'effective']);
    if (!allowed.has(stateRaw)) {
      return res.status(400).json({
        ok: false,
        success: false,
        status: 400,
        message: 'Invalid state. Expected draft|published|effective',
        path: req.originalUrl,
      });
    }

    const fallback = defaultAdminSettings();
    const { value, updatedAt } = await readSetting(ADMIN_SETTINGS_KEY, fallback);

    const { draft, published } = extractAdminPanelDraftPublished(value);
    const effective = deepMerge(defaultAdminPanelPayload(), published, draft);

    const payload = stateRaw === 'draft' ? draft : (stateRaw === 'published' ? published : effective);
    const version =
      (value && typeof value === 'object' && typeof value.version === 'number' ? value.version : null)
      ?? (value && value.adminPanel && typeof value.adminPanel.version === 'number' ? value.adminPanel.version : null)
      ?? 1;

    const db = dbStatusPayload();
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: db.connected ? 'OK' : 'OK (DB unavailable)',
      state: stateRaw,
      version,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      draft,
      published,
      effective,
      payload,
      db,
      data: {
        state: stateRaw,
        version,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        draft,
        published,
        effective,
        payload,
      },
    });
  } catch (e) {
    console.error('[ADMIN_SETTINGS][preview] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

/**
 * GET /api/admin/settings/preview?state=draft|published|effective
 * Alias for Admin Panel preview endpoint.
 *
 * Example:
 *   curl -i "http://localhost:5000/api/admin/settings/preview?state=effective" \
 *     -H "Authorization: Bearer <token>"
 */
router.get('/settings/preview', requireAuth, requireFounderOrPermission('settings.read'), async (req, res, next) => {
  try {
    // Reuse the same behavior as /settings/admin-panel/preview
    req.url = '/settings/admin-panel/preview' + (req._parsedUrl && req._parsedUrl.search ? req._parsedUrl.search : '');
    return router.handle(req, res, next);
  } catch (e) {
    console.error('[ADMIN_SETTINGS][preview-alias] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

// PUT /api/admin/settings
router.put('/settings', requireAdminAuth, async (req, res, next) => {
  try {
    const parsed = AnyObjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid settings payload' });
    }

    const result = await writeSetting(ADMIN_SETTINGS_KEY, parsed.data, req.admin);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, success: false, message: result.message });
    }

    return res.status(200).json({ ok: true, success: true, status: 200, updatedAt: result.updatedAt });
  } catch (e) {
    console.error('[ADMIN_SETTINGS][put] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

// GET /api/admin/public-settings
router.get('/public-settings', requireAdminAuth, async (_req, res, next) => {
  try {
    const fallback = defaultPublicSettings();
    const db = dbStatusPayload();

    if (!db.connected) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'DB unavailable',
        data: fallback,
        updatedAt: null,
        db,
      });
    }

    const { value, updatedAt } = await readSetting(PUBLIC_SETTINGS_KEY, fallback);
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      data: value,
      updatedAt,
      db,
    });
  } catch (e) {
    console.error('[ADMIN_SETTINGS][get-public] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: _req.originalUrl,
    });
  }
});

// PUT /api/admin/public-settings
router.put('/public-settings', requireAdminAuth, async (req, res, next) => {
  try {
    const parsed = AnyObjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid public settings payload' });
    }

    const result = await writeSetting(PUBLIC_SETTINGS_KEY, parsed.data, req.admin);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, success: false, message: result.message });
    }

    return res.status(200).json({ ok: true, success: true, status: 200, updatedAt: result.updatedAt });
  } catch (e) {
    console.error('[ADMIN_SETTINGS][put-public] failed', {
      message: e?.message || String(e),
      name: e?.name,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Internal error',
      path: req.originalUrl,
    });
  }
});

// IMPORTANT: If tickers are managed elsewhere (e.g. Broadcast Center), never 404.
// This is a fallback only — if a dedicated tickers router is mounted earlier, it will handle the request.
router.get('/public-settings/tickers', requireAdminAuth, (_req, res) => {
  return res.status(200).json({ ok: true, success: true, status: 200, managedIn: 'broadcast-center' });
});

// Backward-compatible alias: some admin builds call /public-setting/* (singular)
router.get('/public-setting/tickers', requireAdminAuth, (_req, res) => {
  return res.status(200).json({ ok: true, success: true, status: 200, managedIn: 'broadcast-center' });
});

module.exports = router;
