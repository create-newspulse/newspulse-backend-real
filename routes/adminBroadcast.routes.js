const express = require('express');
const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { generateTranslationsForBroadcastItem, normalizeLang } = require('../services/translationGuard');
let translationWorker;
try {
  translationWorker = require('../services/translationWorker');
} catch (_) {
  translationWorker = null;
}
const {
  getOrCreateSettings,
  adminSettingsResponse,
  patchSettings,
  listItemsLast24hByChannel,
  deleteItemById,
  normalizeChannel,
} = require('../services/broadcastCenter.service');

const router = express.Router();

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function _normalizeLangQuery(v) {
  const s = String(v || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function fail(res, status, code, message, details) {
  return res.status(status).json({
    ok: false,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
    ...(details !== undefined ? { details } : {}),
    // Backward-compat for existing admin clients
    success: false,
    status,
  });
}

function ensureDbOr503(res) {
  if (mongoose.connection.readyState !== 1) {
    fail(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
    return false;
  }
  return true;
}

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, data });
}

function toAdminContract(settings) {
  return {
    breaking: {
      enabled: !!settings?.breaking?.enabled,
      mode: settings?.breaking?.mode || 'auto',
      speed: typeof settings?.breaking?.speedSec === 'number' ? settings.breaking.speedSec : 8,
    },
    live: {
      enabled: !!settings?.live?.enabled,
      mode: settings?.live?.mode || 'auto',
      speed: typeof settings?.live?.speedSec === 'number' ? settings.live.speedSec : 8,
    },
  };
}

function buildPatchPayload(body) {
  const payload = {};
  for (const channel of ['breaking', 'live']) {
    const next = body?.[channel];
    if (!next || typeof next !== 'object') continue;

    payload[channel] = {};

    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) {
      payload[channel].enabled = !!next.enabled;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'mode')) {
      payload[channel].mode = next.mode;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speed')) {
      payload[channel].speedSec = next.speed;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speedSec')) {
      payload[channel].speedSec = next.speedSec;
    }
  }
  return payload;
}

function _resolveAdminDisplayText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (!lang) return typeof d.text === 'string' ? d.text : '';
  const src = typeof d.sourceLang === 'string' ? d.sourceLang : null;
  const by = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const pick =
    (by && typeof by[lang] === 'string' && by[lang]) ||
    (src && by && typeof by[src] === 'string' && by[src]) ||
    (typeof d.text === 'string' ? d.text : '');
  return String(pick || '');
}

function mapItem(doc, options = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const _id = d._id ? String(d._id) : undefined;
  const lang = options && options.lang ? String(options.lang) : null;
  return {
    _id,
    id: _id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    text: typeof d.text === 'string' ? d.text : '',
    ...(lang
      ? {
          displayText: _resolveAdminDisplayText(d, lang),
          sourceLang: typeof d.sourceLang === 'string' ? d.sourceLang : undefined,
          textByLang: d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : {},
          statusByLang: d.statusByLang && typeof d.statusByLang === 'object' ? d.statusByLang : {},
          qualityByLang: d.qualityByLang && typeof d.qualityByLang === 'object' ? d.qualityByLang : {},
        }
      : {}),
    createdAt: d.createdAt || null,
    expiresAt: d.expiresAt || null,
    isLive: Boolean(d.isLive),
  };
}

function normalizeText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (s.length > 160) return null;
  return s;
}

// Admin APIs (protected)
// GET /api/admin/broadcast
router.get('/', requireAdminAuth, async (_req, res) => {
  if (!ensureDbOr503(res)) return;

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  return ok(res, toAdminContract(settings));
});

// PUT /api/admin/broadcast
async function _updateBroadcastSettings(req, res) {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await patchSettings(buildPatchPayload(body));
  if (!result.ok) {
    const status = typeof result.status === 'number' ? result.status : 400;
    const code = status === 503 ? 'DB_UNAVAILABLE' : 'BAD_REQUEST';
    return fail(res, status, code, result.message || 'Invalid request');
  }

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  return ok(res, toAdminContract(settings));
}

router.put('/', requireAdminAuth, _updateBroadcastSettings);

// Some admin UIs use PATCH for settings updates.
router.patch('/', requireAdminAuth, _updateBroadcastSettings);

// GET /api/admin/broadcast/items?type=breaking|live
router.get('/items', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang')
    ? _normalizeLangQuery(req.query && req.query.lang)
    : null;
  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') && !lang) {
    return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
  }

  const type = Object.prototype.hasOwnProperty.call(req.query || {}, 'type')
    ? normalizeChannel(req.query && req.query.type)
    : null;
  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'type') && !type) {
    return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');
  }

  const itemsBy = await listItemsLast24hByChannel();
  if (type) {
    const items = (itemsBy && itemsBy[type]) || [];
    return ok(res, items.map(i => mapItem(i, { lang })));
  }

  const all = []
    .concat((itemsBy && itemsBy.breaking) || [])
    .concat((itemsBy && itemsBy.live) || [])
    .sort((a, b) => {
      const at = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });

  return ok(res, all.map(i => mapItem(i, { lang })));
});

// POST /api/admin/broadcast/items  body { type, text }
router.post('/items', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Support both body.type (new) and query.type (legacy UIs)
  const type = normalizeChannel(body.type) || normalizeChannel(req.query && req.query.type);
  if (!type) {
    return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');
  }

  const text = normalizeText(body.text);
  if (!text) {
    return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');
  }

  const sourceLang = body && Object.prototype.hasOwnProperty.call(body, 'lang')
    ? _normalizeLangQuery(body.lang)
    : null;
  if (body && Object.prototype.hasOwnProperty.call(body, 'lang') && !sourceLang) {
    return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const created = await BroadcastItem.create({
    type,
    text,
    sourceLang: normalizeLang(sourceLang || 'gu', 'gu'),
    textByLang: {
      [normalizeLang(sourceLang || 'gu', 'gu')]: text,
    },
    statusByLang: {
      [normalizeLang(sourceLang || 'gu', 'gu')]: 'APPROVED',
      ...(normalizeLang(sourceLang || 'gu', 'gu') !== 'en' ? { en: 'PROCESSING' } : {}),
      ...(normalizeLang(sourceLang || 'gu', 'gu') !== 'hi' ? { hi: 'PROCESSING' } : {}),
      ...(normalizeLang(sourceLang || 'gu', 'gu') !== 'gu' ? { gu: 'PROCESSING' } : {}),
    },
    qualityByLang: {
      [normalizeLang(sourceLang || 'gu', 'gu')]: 100,
    },
    isLive: true,
    expiresAt,
  });

  // Phase 1: generate translations asynchronously; safe defaults will BLOCK when provider isn't configured.
  try {
    setImmediate(() => {
      if (translationWorker && translationWorker.isEnabled && translationWorker.isEnabled()) {
        translationWorker.enqueueBroadcastItemJob({ itemId: created._id, targetLangs: ['en', 'hi'] }).catch(() => {});
        return;
      }
      generateTranslationsForBroadcastItem(created._id).catch(() => {});
    });
  } catch (_) {}

  return res.status(201).json({ ok: true, success: true, data: mapItem(created) });
});

// PATCH /api/admin/broadcast/items/:id
// Supports updating item live state and/or text.
router.patch('/items/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const next = {};

  // Some admin UIs use `enabled` for item state.
  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    next.isLive = Boolean(body.enabled);
  }

  // Support both `isLive` and legacy `live` naming.
  if (Object.prototype.hasOwnProperty.call(body, 'live')) {
    next.isLive = Boolean(body.live);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'isLive')) {
    next.isLive = Boolean(body.isLive);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'text')) {
    const t = normalizeText(body.text);
    if (!t) {
      return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');
    }
    next.text = t;
  }

  if (Object.keys(next).length === 0) {
    return fail(res, 400, 'BAD_REQUEST', 'No supported fields to update');
  }

  const updated = await BroadcastItem.findByIdAndUpdate(id, { $set: next }, { new: true }).lean();
  if (!updated) {
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  }

  return ok(res, mapItem(updated));
});

// DELETE /api/admin/broadcast/items/:id
router.delete('/items/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const result = await deleteItemById(req.params.id);
  if (!result.ok) {
    const status = typeof result.status === 'number' ? result.status : 404;
    const code = status === 503 ? 'DB_UNAVAILABLE' : status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
    return fail(res, status, code, result.message || 'Failed');
  }

  return res.status(200).json({ ok: true, success: true });
});

module.exports = router;
