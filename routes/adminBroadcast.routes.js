const express = require('express');
const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const { requireAdminAuth } = require('../middleware/adminAuth');

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

function _normalizeExpiresInMinutes(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const minutes = Math.floor(n);
  if (minutes <= 0) return null;
  // Guardrail: don't allow extremely long expiries by accident.
  if (minutes > 7 * 24 * 60) return null;
  return minutes;
}

function _normalizeExpiresInHours(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const hours = Math.floor(n);
  if (hours < 1 || hours > 168) return null;
  return hours;
}

function _parseExpiresAt(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
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
    const now = Date.now();
    const items = ((itemsBy && itemsBy[type]) || [])
      .filter((i) => Boolean(i && i.isLive))
      .filter((i) => {
        if (!i || !i.expiresAt) return true;
        const t = new Date(i.expiresAt).getTime();
        return Number.isFinite(t) ? t > now : true;
      })
      .sort((a, b) => {
        const at = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      })
      .slice(0, 50);
    return ok(res, items.map(i => mapItem(i, { lang })));
  }

  const now = Date.now();
  const all = []
    .concat((itemsBy && itemsBy.breaking) || [])
    .concat((itemsBy && itemsBy.live) || [])
    .filter((i) => Boolean(i && i.isLive))
    .filter((i) => {
      if (!i || !i.expiresAt) return true;
      const t = new Date(i.expiresAt).getTime();
      return Number.isFinite(t) ? t > now : true;
    })
    .sort((a, b) => {
      const at = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });

  return ok(res, all.slice(0, 50).map(i => mapItem(i, { lang })));
});

// POST /api/admin/broadcast/items  body { type, text }
router.post('/items', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Accept type/lang from either JSON body (preferred) or query params (fallback).
  const type = normalizeChannel(body.type) || normalizeChannel(req.query && req.query.type);
  if (!type) {
    return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');
  }

  const text = normalizeText(body.text);
  if (!text) {
    return fail(res, 400, 'INVALID_TEXT', 'Invalid text. Must be non-empty and <= 160 chars');
  }

  const rawLang = Object.prototype.hasOwnProperty.call(body, 'lang') ? body.lang : (req.query && req.query.lang);
  if (rawLang === undefined) {
    return fail(res, 400, 'MISSING_LANG', 'Missing lang. Expected en|hi|gu');
  }
  const lang = _normalizeLangQuery(rawLang);
  if (!lang) {
    return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
  }

  // Optional explicit expiresAt (preferred in Phase 1).
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt') || Object.prototype.hasOwnProperty.call(req.query || {}, 'expiresAt');
  const rawExpiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt') ? body.expiresAt : (req.query && req.query.expiresAt);
  const parsedExpiresAt = hasExpiresAt ? _parseExpiresAt(rawExpiresAt) : null;
  if (hasExpiresAt && !parsedExpiresAt) {
    return fail(res, 400, 'INVALID_EXPIRES_AT', 'Invalid expiresAt. Expected a valid date/time');
  }

  // Preferred: expiresInHours (1..168), default 24.
  // Backward-compat: accept expiresInMinutes (converted to hours, rounded up) if provided.
  const expiresHoursFromBodyOrQuery =
    (Object.prototype.hasOwnProperty.call(body, 'expiresInHours') ? body.expiresInHours : undefined)
    ?? (req.query && req.query.expiresInHours);
  let expiresInHours = _normalizeExpiresInHours(expiresHoursFromBodyOrQuery);

  if (expiresInHours === null) {
    const expiresInMinutes = _normalizeExpiresInMinutes(
      (Object.prototype.hasOwnProperty.call(body, 'expiresInMinutes') ? body.expiresInMinutes : undefined)
      ?? (req.query && req.query.expiresInMinutes)
    );
    if (expiresInMinutes) {
      expiresInHours = Math.ceil(expiresInMinutes / 60);
      if (expiresInHours < 1) expiresInHours = 1;
      if (expiresInHours > 168) expiresInHours = null;
    }
  }

  if (expiresHoursFromBodyOrQuery !== undefined && expiresInHours === null) {
    return fail(res, 400, 'INVALID_EXPIRES', 'Invalid expiresInHours. Expected 1..168');
  }

  if (expiresInHours === null) expiresInHours = 24;

  const now = new Date();

  // If expiresAt provided, validate it's within 1..168h from now.
  // (Prevents accidental far-future TTLs that clog the UI.)
  let expiresAt = parsedExpiresAt;
  if (expiresAt) {
    const deltaMs = expiresAt.getTime() - now.getTime();
    const deltaHours = Math.ceil(deltaMs / (60 * 60 * 1000));
    if (!Number.isFinite(deltaHours) || deltaHours < 1 || deltaHours > 168) {
      return fail(res, 400, 'INVALID_EXPIRES_AT', 'expiresAt must be between 1 and 168 hours in the future');
    }
    expiresInHours = deltaHours;
  } else {
    expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);
  }

  // Single-line audit log per requirement.
  try {
    console.log('[broadcast] create item', `type=${type}`, `lang=${lang}`, `expiresInHours=${expiresInHours}`);
  } catch (_) {}

  const resolvedLang = String(lang || 'gu').trim().toLowerCase();

  const createPayload = {
    type,
    text,
    createdAt: now,
    isLive: true,
    expiresAt,
    // Store both legacy + new fields.
    language: resolvedLang,
    sourceLang: resolvedLang,
    textByLang: { [resolvedLang]: text },
    statusByLang: { [resolvedLang]: 'APPROVED' },
    qualityByLang: { [resolvedLang]: 100 },
  };

  const created = await BroadcastItem.create(createPayload);

  // Translation queue/worker removed: no background jobs enqueued.

  // Phase 1 contract: 201 + created item.
  return res.status(201).json({ ok: true, success: true, item: mapItem(created, { lang: resolvedLang }) });
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
