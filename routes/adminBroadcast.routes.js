const express = require('express');
const mongoose = require('mongoose');

const noCache = require('../middleware/noCache');

const BroadcastItem = require('../models/BroadcastItem');
const { requireAdminAuth } = require('../middleware/adminAuth');

const guardedTranslate = require('../services/translate/guardedTranslate');
const { shouldAcceptTranslation } = require('../services/translate/i18nQuality');
const broadcastItemI18n = require('../services/broadcastItemI18n.service');

const {
  getOrCreateSettings,
  adminSettingsResponse,
  patchSettings,
  listItemsLast24hByChannel,
  deleteItemById,
  normalizeChannel,
  computePublicEnabled,
} = require('../services/broadcastCenter.service');

const { emitBroadcastUpdated } = require('../services/broadcastSse.service');
const { invalidateBroadcastCaches } = require('../lib/cache');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');

const router = express.Router();

// Prevent stale admin panel responses (Render/Vercel/proxies).
router.use(noCache);

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function _normalizeLangQuery(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
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
  const resolveDurationSec = (s) => {
    if (!s || typeof s !== 'object') return 18;
    const v =
      (typeof s.durationSec === 'number' ? s.durationSec : null) ??
      (typeof s.durationSeconds === 'number' ? s.durationSeconds : null) ??
      (typeof s.tickerSpeedSeconds === 'number' ? s.tickerSpeedSeconds : null) ??
      (typeof s.speedSec === 'number' ? s.speedSec : null);
    return typeof v === 'number' ? v : 18;
  };

  return {
    breaking: {
      enabled: !!settings?.breaking?.enabled,
      mode: settings?.breaking?.mode || 'auto',
      durationSec: resolveDurationSec(settings?.breaking),
    },
    live: {
      enabled: !!settings?.live?.enabled,
      mode: settings?.live?.mode || 'auto',
      durationSec: resolveDurationSec(settings?.live),
    },
  };
}

function toAdminConfigContract(settings, itemsByChannel) {
  const breakingItems = Array.isArray(itemsByChannel?.breaking) ? itemsByChannel.breaking : [];
  const liveItems = Array.isArray(itemsByChannel?.live) ? itemsByChannel.live : [];

  const resolveDurationSec = (s) => {
    if (!s || typeof s !== 'object') return 18;
    const v =
      (typeof s.durationSec === 'number' ? s.durationSec : null) ??
      (typeof s.durationSeconds === 'number' ? s.durationSeconds : null) ??
      (typeof s.tickerSpeedSeconds === 'number' ? s.tickerSpeedSeconds : null) ??
      (typeof s.speedSec === 'number' ? s.speedSec : null);
    return typeof v === 'number' ? v : 18;
  };

  const breakingDuration = resolveDurationSec(settings?.breaking);
  const liveDuration = resolveDurationSec(settings?.live);

  const breakingMaxItems = typeof settings?.breaking?.maxItems === 'number' ? settings.breaking.maxItems : undefined;
  const liveMaxItems = typeof settings?.live?.maxItems === 'number' ? settings.live.maxItems : undefined;
  const pauseOnHover = typeof settings?.pauseOnHover === 'boolean' ? settings.pauseOnHover : undefined;

  return {
    breakingMaxItems,
    liveMaxItems,
    breakingSpeedSec: breakingDuration,
    liveSpeedSec: liveDuration,
    pauseOnHover,
    breaking: {
      // Admin config should reflect the stored flag (not computed/effective enabled).
      enabled: Boolean(settings?.breaking?.enabled),
      mode: settings?.breaking?.mode || 'auto',
      durationSec: breakingDuration,
      maxItems: breakingMaxItems,
    },
    live: {
      enabled: Boolean(settings?.live?.enabled),
      mode: settings?.live?.mode || 'auto',
      durationSec: liveDuration,
      maxItems: liveMaxItems,
    },
  };
}

function _buildConfigPatchPayload(type, body) {
  const b = body && typeof body === 'object' ? body : {};
  const payload = {};

  const channel = type ? normalizeChannel(type) : null;
  const channels = channel ? [channel] : ['breaking', 'live'];

  for (const ch of channels) {
    const next = channel
      ? b
      : (ch === 'live' ? ((b && b.live) || (b && b.liveUpdates)) : (b && b[ch]));
    if (!next || typeof next !== 'object') continue;

    payload[ch] = {};

    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) {
      payload[ch].enabled = Boolean(next.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'mode')) {
      payload[ch].mode = next.mode;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'maxItems')) {
      payload[ch].maxItems = next.maxItems;
    }

    // Flat compatibility keys when updating both channels at once.
    if (!channel) {
      const maxKey = ch === 'breaking' ? 'breakingMaxItems' : 'liveMaxItems';
      if (Object.prototype.hasOwnProperty.call(b, maxKey)) {
        payload[ch].maxItems = b[maxKey];
      }

      const speedKey = ch === 'breaking' ? 'breakingSpeedSec' : 'liveSpeedSec';
      if (Object.prototype.hasOwnProperty.call(b, speedKey)) {
        payload[ch].speedSec = b[speedKey];
      }
    }

    // Prefer durationSec (requested contract), but accept legacy names too.
    if (Object.prototype.hasOwnProperty.call(next, 'durationSec')) {
      payload[ch].durationSeconds = next.durationSec;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'durationSeconds')) {
      payload[ch].durationSeconds = next.durationSeconds;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSeconds')) {
      payload[ch].scrollDurationSeconds = next.scrollDurationSeconds;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSec')) {
      payload[ch].scrollDurationSeconds = next.scrollDurationSec;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'tickerSpeedSeconds')) {
      payload[ch].tickerSpeedSeconds = next.tickerSpeedSeconds;
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, 'pauseOnHover')) {
    payload.pauseOnHover = b.pauseOnHover;
  }

  return payload;
}

function _summarizePatchKeys(body) {
  const out = [];
  const b = body && typeof body === 'object' ? body : {};
  if (Object.prototype.hasOwnProperty.call(b, 'pauseOnHover')) out.push('pauseOnHover');
  for (const ch of ['breaking', 'live']) {
    const next = ch === 'live' ? ((b && b.live) || (b && b.liveUpdates)) : b[ch];
    if (!next || typeof next !== 'object') continue;
    for (const k of ['enabled', 'mode', 'durationSec', 'durationSeconds', 'tickerSpeedSeconds', 'scrollDurationSeconds', 'scrollDurationSec', 'speedSec', 'speed', 'maxItems']) {
      if (Object.prototype.hasOwnProperty.call(next, k)) out.push(`${ch}.${k}`);
    }
  }
  for (const k of ['breakingMaxItems', 'liveMaxItems', 'breakingSpeedSec', 'liveSpeedSec']) {
    if (Object.prototype.hasOwnProperty.call(b, k)) out.push(k);
  }
  return out;
}

function buildPatchPayload(body) {
  const payload = {};

  const b = body && typeof body === 'object' ? body : {};

  const hasNested =
    (b.breaking && typeof b.breaking === 'object') ||
    (b.live && typeof b.live === 'object') ||
    (b.liveUpdates && typeof b.liveUpdates === 'object');

  // Flat/root payload compatibility:
  // - Either legacy per-channel fields like breakingEnabled/liveEnabled
  // - Or root fields (enabled/mode/durationSec/etc) applied to BOTH channels.
  // This keeps nested { breaking, live } as the single source of truth.
  if (!hasNested) {
    const rootToBoth = {};
    for (const k of ['enabled', 'mode', 'durationSec', 'durationSeconds', 'tickerSpeedSeconds', 'scrollDurationSeconds', 'scrollDurationSec', 'speed', 'speedSec', 'speedSeconds']) {
      if (Object.prototype.hasOwnProperty.call(b, k)) rootToBoth[k] = b[k];
    }

    const flat = { ...b };
    if (Object.keys(rootToBoth).length > 0) {
      flat.breaking = rootToBoth;
      flat.live = rootToBoth;
    } else {
      const breakingFlat = {};
      const liveFlat = {};

      const pick = (srcKey, dest, destKey) => {
        if (Object.prototype.hasOwnProperty.call(b, srcKey)) dest[destKey] = b[srcKey];
      };

      pick('breakingEnabled', breakingFlat, 'enabled');
      pick('liveEnabled', liveFlat, 'enabled');

      pick('breakingMode', breakingFlat, 'mode');
      pick('liveMode', liveFlat, 'mode');

      pick('breakingDurationSeconds', breakingFlat, 'durationSeconds');
      pick('liveDurationSeconds', liveFlat, 'durationSeconds');

      pick('breakingDurationSec', breakingFlat, 'durationSec');
      pick('liveDurationSec', liveFlat, 'durationSec');

      pick('breakingTickerSpeedSeconds', breakingFlat, 'tickerSpeedSeconds');
      pick('liveTickerSpeedSeconds', liveFlat, 'tickerSpeedSeconds');

      pick('breakingSpeedSec', breakingFlat, 'speedSec');
      pick('liveSpeedSec', liveFlat, 'speedSec');

      if (Object.keys(breakingFlat).length > 0) flat.breaking = breakingFlat;
      if (Object.keys(liveFlat).length > 0) flat.live = liveFlat;
    }

    body = flat;
  }

  for (const channel of ['breaking', 'live']) {
    const next = channel === 'live' ? (body?.live ?? body?.liveUpdates) : body?.[channel];
    if (!next || typeof next !== 'object') continue;

    payload[channel] = {};

    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) {
      payload[channel].enabled = !!next.enabled;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'mode')) {
      payload[channel].mode = next.mode;
    }

    // Preferred canonical field
    if (Object.prototype.hasOwnProperty.call(next, 'durationSec')) {
      payload[channel].durationSec = next.durationSec;
    }

    // Accept legacy duration field names
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSeconds')) {
      payload[channel].scrollDurationSeconds = next.scrollDurationSeconds;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'scrollDurationSec')) {
      payload[channel].scrollDurationSeconds = next.scrollDurationSec;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speed')) {
      payload[channel].speedSec = next.speed;
    }

    if (Object.prototype.hasOwnProperty.call(next, 'speedSec')) {
      payload[channel].speedSec = next.speedSec;
    }

    // New explicit field name
    if (Object.prototype.hasOwnProperty.call(next, 'tickerSpeedSeconds')) {
      payload[channel].tickerSpeedSeconds = next.tickerSpeedSeconds;
    }

    // Phase 1: UI field name
    if (Object.prototype.hasOwnProperty.call(next, 'durationSeconds')) {
      payload[channel].durationSeconds = next.durationSeconds;
    }

    // Some clients may send speedSeconds
    if (Object.prototype.hasOwnProperty.call(next, 'speedSeconds')) {
      payload[channel].tickerSpeedSeconds = next.speedSeconds;
    }
  }
  return payload;
}

function _resolveAdminDisplayText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (!lang) return typeof d.text === 'string' ? d.text : '';
  const src = typeof d.sourceLang === 'string' ? d.sourceLang : null;

  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (i18n && typeof i18n[lang] === 'string' && i18n[lang].trim() ? i18n[lang] : null) ||
    (legacy && typeof legacy[lang] === 'string' && legacy[lang].trim() ? legacy[lang] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (SUPPORTED_LANGS.has('gu') && i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (typeof d.text === 'string' ? d.text : '');

  return String(pick || '').trim();
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
          text_i18n: d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : {},
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
router.get('/', requireAdminAuth, noCache, async (_req, res) => {
  if (!ensureDbOr503(res)) return;

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  return ok(res, toAdminContract(settings));
});

// Broadcast Config API (merge-safe)
// GET  /api/admin/broadcast/config
// PUT  /api/admin/broadcast/config          -> replaces BOTH breaking+live together
// PATCH /api/admin/broadcast/config/:type   -> updates only one type (merge-safe)
router.get('/config', requireAdminAuth, async (_req, res) => {
  if (!ensureDbOr503(res)) return;

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  const itemsBy = await listItemsLast24hByChannel();
  return res.status(200).json(toAdminConfigContract(settings, itemsBy));
});

router.put('/config', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!body.breaking || typeof body.breaking !== 'object' || !body.live || typeof body.live !== 'object') {
    return fail(res, 400, 'BAD_REQUEST', 'PUT /broadcast/config requires both breaking and live objects');
  }

  const result = await patchSettings(_buildConfigPatchPayload(null, body));
  if (!result.ok) {
    const status = typeof result.status === 'number' ? result.status : 400;
    const code = status === 503 ? 'DB_UNAVAILABLE' : 'BAD_REQUEST';
    return fail(res, status, code, result.message || 'Invalid request');
  }

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  const itemsBy = await listItemsLast24hByChannel();

  emitBroadcastUpdated({ reason: 'admin_config_put' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});
  return res.status(200).json(toAdminConfigContract(settings, itemsBy));
});

// PATCH /api/admin/broadcast/config
// Merge-safe partial update for either/both channels.
router.patch('/config', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = _buildConfigPatchPayload(null, body);
  const touched = _summarizePatchKeys(body);
  const hasChannelUpdates =
    (payload.breaking && Object.keys(payload.breaking).length > 0) ||
    (payload.live && Object.keys(payload.live).length > 0);
  const hasRootUpdates = Object.prototype.hasOwnProperty.call(payload, 'pauseOnHover');

  if (!hasChannelUpdates && !hasRootUpdates) {
    return fail(res, 400, 'BAD_REQUEST', 'No supported fields to update (enabled, mode, durationSec/scrollDurationSeconds, maxItems, pauseOnHover)');
  }

  // Minimal debug log (no secrets)
  try {
    console.log('[broadcast][config][patch]', { keys: touched });
  } catch (_) {}

  const result = await patchSettings(payload);
  if (!result.ok) {
    const status = typeof result.status === 'number' ? result.status : 400;
    const code = status === 503 ? 'DB_UNAVAILABLE' : 'BAD_REQUEST';
    return fail(res, status, code, result.message || 'Invalid request');
  }

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  const itemsBy = await listItemsLast24hByChannel();

  emitBroadcastUpdated({ reason: 'admin_config_patch_merge' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});
  return res.status(200).json(toAdminConfigContract(settings, itemsBy));
});

router.patch('/config/:type', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const type = normalizeChannel(req.params && req.params.type);
  if (!type) return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = _buildConfigPatchPayload(type, body);
  if (!payload[type] || Object.keys(payload[type]).length === 0) {
    return fail(res, 400, 'BAD_REQUEST', 'No supported fields to update (enabled, mode, durationSec)');
  }

  try {
    console.log('[broadcast][config][patch-one]', { type, keys: _summarizePatchKeys({ [type]: body }) });
  } catch (_) {}

  const result = await patchSettings(payload);
  if (!result.ok) {
    const status = typeof result.status === 'number' ? result.status : 400;
    const code = status === 503 ? 'DB_UNAVAILABLE' : 'BAD_REQUEST';
    return fail(res, status, code, result.message || 'Invalid request');
  }

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  const itemsBy = await listItemsLast24hByChannel();

  emitBroadcastUpdated({ reason: 'admin_config_patch' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});
  return res.status(200).json(toAdminConfigContract(settings, itemsBy));
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

  // Minimal debug log showing saved speeds (helps diagnose UI overwrites)
  try {
    const doc = result.settings || null;
    const breakingSpeed = doc?.breaking?.tickerSpeedSeconds ?? doc?.breaking?.speedSec;
    const liveSpeed = doc?.live?.tickerSpeedSeconds ?? doc?.live?.speedSec;
    console.debug('[broadcast][settings][save]', { breakingTickerSpeedSeconds: breakingSpeed, liveTickerSpeedSeconds: liveSpeed });
  } catch (_) {}

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);

  emitBroadcastUpdated({ reason: 'admin_settings_save' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});
  return ok(res, toAdminContract(settings));
}

router.put('/', requireAdminAuth, _updateBroadcastSettings);

// Some admin panels still use POST for updates.
router.post('/', requireAdminAuth, _updateBroadcastSettings);

// Some admin UIs use PATCH for settings updates.
router.patch('/', requireAdminAuth, _updateBroadcastSettings);

// Phase 1 compatibility: PATCH /api/admin/broadcast/settings
// and via mount alias: PATCH /admin-api/admin/broadcast/settings
router.patch('/settings', requireAdminAuth, _updateBroadcastSettings);

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
  // lang is optional; if omitted, best-effort detect (fallback gu).
  let lang = rawLang === undefined ? null : _normalizeLangQuery(rawLang);
  if (rawLang !== undefined && !lang) return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
  if (!lang) {
    try {
      // Best-effort only; missing key should not block creation.
      const detected = await require('../services/googleTranslate.service').detectLanguage(text);
      const dl = detected && detected.ok ? _normalizeLangQuery(detected.lang) : null;
      lang = dl || 'gu';
    } catch (_) {
      lang = 'gu';
    }
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

  const resolvedLang = _normalizeLangQuery(lang) || 'gu';

  // Optional: allow disabling auto-translation (best-effort by default).
  const autoTranslate = Object.prototype.hasOwnProperty.call(body, 'autoTranslate')
    ? Boolean(body.autoTranslate)
    : (Object.prototype.hasOwnProperty.call(req.query || {}, 'autoTranslate') ? String(req.query.autoTranslate).toLowerCase() !== 'false' : true);

  const createPayload = {
    type,
    text,
    createdAt: now,
    isLive: true,
    expiresAt,
    // Store both legacy + new fields.
    language: resolvedLang,
    sourceLang: resolvedLang,
    text_i18n: { [resolvedLang]: text },
    translations: { [resolvedLang]: text },
    textByLang: { [resolvedLang]: text },
    statusByLang: { [resolvedLang]: 'APPROVED' },
    qualityByLang: { [resolvedLang]: 100 },
  };

  const created = await BroadcastItem.create(createPayload);

  // Auto-translate (best effort) into remaining supported langs.
  try {
    if (!autoTranslate) throw new Error('AUTO_TRANSLATE_DISABLED');
    const translator = async (raw, sourceLang, targetLang) => {
      // Use guardrails for quality + fallback behavior; cached at broadcastItemI18n level.
      return guardedTranslate.translateWithGuardrails(raw, sourceLang, targetLang, { maxLen: 160 });
    };

    const built = await broadcastItemI18n.buildTextI18n({ text, sourceLang: resolvedLang, translator });
    const i18n = built && built.text_i18n ? built.text_i18n : { [resolvedLang]: text };

    created.text_i18n = created.text_i18n && typeof created.text_i18n === 'object' ? created.text_i18n : {};
    created.translations = created.translations && typeof created.translations === 'object' ? created.translations : {};
    created.textByLang = created.textByLang && typeof created.textByLang === 'object' ? created.textByLang : {};

    for (const targetLang of ['en', 'hi', 'gu']) {
      const clipped = typeof i18n[targetLang] === 'string' && i18n[targetLang].trim() ? i18n[targetLang].trim().slice(0, 160) : null;
      if (!clipped) continue;

      created.text_i18n[targetLang] = clipped;
      created.translations[targetLang] = clipped;
      created.textByLang[targetLang] = clipped;

      // Preserve existing heuristics/status grading on translated langs.
      if (targetLang !== resolvedLang) {
        const accept = shouldAcceptTranslation(text, clipped, resolvedLang, targetLang);
        const needsReview = !accept;

        created.statusByLang = created.statusByLang && typeof created.statusByLang === 'object' ? created.statusByLang : {};
        created.qualityByLang = created.qualityByLang && typeof created.qualityByLang === 'object' ? created.qualityByLang : {};
        created.statusByLang[targetLang] = needsReview ? 'NEEDS_REVIEW' : 'APPROVED';
        created.qualityByLang[targetLang] = 100;
      }
    }

    await created.save();
  } catch (e) {
    // Best effort only; missing key should not block item creation.
  }

  emitBroadcastUpdated({ reason: 'admin_item_create' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

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

  if (Object.prototype.hasOwnProperty.call(body, 'lang')) {
    const l = _normalizeLangQuery(body.lang);
    if (!l) return fail(res, 400, 'INVALID_LANG', 'Invalid lang. Expected en|hi|gu');
    next.sourceLang = l;
    next.language = l;
  }

  if (Object.keys(next).length === 0) {
    return fail(res, 400, 'BAD_REQUEST', 'No supported fields to update');
  }

  const doc = await BroadcastItem.findById(id);
  if (!doc) {
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  }

  for (const [k, v] of Object.entries(next)) doc.set(k, v);

  const textChanged = Object.prototype.hasOwnProperty.call(next, 'text');
  const langChanged = Object.prototype.hasOwnProperty.call(next, 'sourceLang') || Object.prototype.hasOwnProperty.call(next, 'language');

  // If text OR lang changed, regenerate translations and persist.
  if (textChanged || langChanged) {
    let srcLang = _normalizeLangQuery(doc.sourceLang) || _normalizeLangQuery(doc.language);
    if (!srcLang && textChanged) {
      try {
        const detected = await require('../services/googleTranslate.service').detectLanguage(doc.text);
        const dl = detected && detected.ok ? _normalizeLangQuery(detected.lang) : null;
        srcLang = dl || 'gu';
      } catch (_) {
        srcLang = 'gu';
      }
    }
    if (!srcLang) srcLang = 'gu';

    doc.sourceLang = srcLang;
    doc.language = srcLang;

    const translator = async (raw, sourceLang, targetLang) => {
      return guardedTranslate.translateWithGuardrails(raw, sourceLang, targetLang, { maxLen: 160 });
    };

    const built = await broadcastItemI18n.buildTextI18n({ text: doc.text, sourceLang: srcLang, translator });
    const i18n = built && built.text_i18n ? built.text_i18n : { [srcLang]: String(doc.text || '').trim().slice(0, 160) };

    doc.text_i18n = doc.text_i18n && typeof doc.text_i18n === 'object' ? doc.text_i18n : {};
    doc.translations = doc.translations && typeof doc.translations === 'object' ? doc.translations : {};
    doc.textByLang = doc.textByLang && typeof doc.textByLang === 'object' ? doc.textByLang : {};

    for (const l of ['en', 'hi', 'gu']) {
      const clipped = typeof i18n[l] === 'string' && i18n[l].trim() ? i18n[l].trim().slice(0, 160) : null;
      if (!clipped) continue;
      doc.text_i18n[l] = clipped;
      doc.translations[l] = clipped;
      doc.textByLang[l] = clipped;
    }
  }

  const saved = await doc.save();

  emitBroadcastUpdated({ reason: 'admin_item_patch' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

  return ok(res, mapItem(saved));
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

  emitBroadcastUpdated({ reason: 'admin_item_delete' }).catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  invalidateBroadcastCaches().catch(() => {});

  return res.status(200).json({ ok: true, success: true });
});

module.exports = router;
