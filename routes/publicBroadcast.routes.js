const express = require('express');

const {
  computePublicPayload,
  listItemsLast24hByChannel,
  normalizeChannel,
  getOrCreateSettings,
  adminSettingsResponse,
  computePublicEnabled,
} = require('../services/broadcastCenter.service');

const { getBroadcastVersion } = require('../services/broadcastVersion.service');
const {
  normalizeLang: _normalizeLang,
  buildBroadcastSnapshot,
  addClient,
  setNoCacheHeaders,
} = require('../services/broadcastSse.service');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function _requestedLangFromReq(req) {
  const q = (req && req.query) || {};
  // Preserve Phase 1 behavior: only treat query lang as requested when explicitly present.
  const hasQueryLang = Object.prototype.hasOwnProperty.call(q, 'lang');
  const queryLang = hasQueryLang ? _normalizeLang(q.lang, 'gu') : null;
  if (queryLang) return queryLang;

  const headerLang = req && req.headers ? (req.headers['x-lang'] || req.headers['x-language']) : null;
  if (headerLang) return _normalizeLang(headerLang, 'gu');

  const midLang = req && req.lang ? req.lang : null;
  if (midLang) return _normalizeLang(midLang, 'gu');

  return null;
}

function _resolvePublicItemText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = _normalizeLang(lang, 'gu');

  const src = SUPPORTED_LANGS.has(String(d.sourceLang || ''))
    ? String(d.sourceLang)
    : (SUPPORTED_LANGS.has(String(d.language || '')) ? String(d.language) : null);

  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (i18n && typeof i18n[target] === 'string' && i18n[target].trim() ? i18n[target] : null) ||
    (legacy && typeof legacy[target] === 'string' && legacy[target].trim() ? legacy[target] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (i18n && (typeof i18n.gu === 'string' && i18n.gu.trim()) ? i18n.gu : null) ||
    (i18n && (typeof i18n.hi === 'string' && i18n.hi.trim()) ? i18n.hi : null) ||
    (i18n && (typeof i18n.en === 'string' && i18n.en.trim()) ? i18n.en : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');

  return String(pick || '').trim();
}

const router = express.Router();

function sendError(res, status, code, message, details) {
  const payload = {
    ok: false,
    code: String(code || 'SERVER_ERROR'),
    message: String(message || 'Request failed'),
  };
  if (details !== undefined) payload.details = details;
  return res.status(status).json(payload);
}

function _noStore(res) {
  try {
    setNoCacheHeaders(res);
  } catch (_) {}
}

function _wantsDetailed(req) {
  const q = (req && req.query) || {};
  const v = String(q.detailed || q.detail || q.full || q.v || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === '2' || v === 'full';
}

function _mapPublicItem(doc, options = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  const lang = options && options.lang ? String(options.lang) : null;
  return {
    id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    text: lang ? _resolvePublicItemText(d, lang) : (typeof d.text === 'string' ? d.text : ''),
    createdAt: d.createdAt || null,
    expiresAt: d.expiresAt || null,
  };
}

// GET /api/public/broadcast
// Default: stable payload used by the website.
// Optional: detailed payload (query ?detailed=1) with item objects + id mapping.
router.get('/', async (req, res) => {
  const requestedLang = _requestedLangFromReq(req);

  const version = await getBroadcastVersion().catch(() => 0);

  // New Phase 1 contract: only when ?lang is provided.
  if (requestedLang) {
    try {
      _noStore(res);

      const snapshot = await buildBroadcastSnapshot({ lang: requestedLang, version });
      const breakingItems = Array.isArray(snapshot?.breaking?.items) ? snapshot.breaking.items : [];
      const liveItems = Array.isArray(snapshot?.live?.items) ? snapshot.live.items : [];
      return res.status(200).json({
        breaking: {
          enabled: Boolean(snapshot?.breaking?.enabled),
          mode: snapshot?.breaking?.mode || 'auto',
          // Canonical API field
          durationSec: typeof snapshot?.breaking?.durationSeconds === 'number' ? snapshot.breaking.durationSeconds : 12,
          // Backward-compat fields
          durationSeconds: typeof snapshot?.breaking?.durationSeconds === 'number' ? snapshot.breaking.durationSeconds : 12,
          tickerSpeedSeconds: typeof snapshot?.breaking?.durationSeconds === 'number' ? snapshot.breaking.durationSeconds : 12,
          items: breakingItems.map(i => String(i && i.text ? i.text : '')).filter(Boolean),
        },
        live: {
          enabled: Boolean(snapshot?.live?.enabled),
          mode: snapshot?.live?.mode || 'auto',
          // Canonical API field
          durationSec: typeof snapshot?.live?.durationSeconds === 'number' ? snapshot.live.durationSeconds : 12,
          // Backward-compat fields
          durationSeconds: typeof snapshot?.live?.durationSeconds === 'number' ? snapshot.live.durationSeconds : 12,
          tickerSpeedSeconds: typeof snapshot?.live?.durationSeconds === 'number' ? snapshot.live.durationSeconds : 12,
          items: liveItems.map(i => String(i && i.text ? i.text : '')).filter(Boolean),
        },
      });
    } catch (_) {
      _noStore(res);
      return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast');
    }
  }

  if (_wantsDetailed(req)) {
    try {
      _noStore(res);
      const doc = await getOrCreateSettings();
      const settings = adminSettingsResponse(doc);
      const itemsBy = await listItemsLast24hByChannel();

      const breakingItems = Array.isArray(itemsBy.breaking) ? itemsBy.breaking : [];
      const liveItems = Array.isArray(itemsBy.live) ? itemsBy.live : [];

      const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
      const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

      return res.status(200).json({
        _meta: { version },
        breaking: {
          enabled: breakingEnabled,
          mode: settings.breaking.mode,
          // Canonical API field
          durationSec: settings.breaking.durationSec,
          speed: settings.breaking.speedSec,
          speedSec: settings.breaking.speedSec,
          tickerSpeedSeconds: settings.breaking.tickerSpeedSeconds,
          durationSeconds: settings.breaking.durationSeconds,
          items: breakingItems.map(_mapPublicItem),
        },
        live: {
          enabled: liveEnabled,
          mode: settings.live.mode,
          // Canonical API field
          durationSec: settings.live.durationSec,
          speed: settings.live.speedSec,
          speedSec: settings.live.speedSec,
          tickerSpeedSeconds: settings.live.tickerSpeedSeconds,
          durationSeconds: settings.live.durationSeconds,
          items: liveItems.map(_mapPublicItem),
        },
      });
    } catch (_) {
      _noStore(res);
      return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast');
    }
  }

  try {
    _noStore(res);
    const payload = await computePublicPayload();
    if (payload && typeof payload === 'object') {
      payload._meta = payload._meta && typeof payload._meta === 'object' ? payload._meta : {};
      payload._meta.version = version;

      // Ensure stable field name for the website.
      if (payload.breaking && typeof payload.breaking === 'object') {
        payload.breaking.tickerSpeedSeconds = typeof payload.breaking.speedSec === 'number' ? payload.breaking.speedSec : 12;
        payload.breaking.durationSec = typeof payload.breaking.durationSec === 'number'
          ? payload.breaking.durationSec
          : (typeof payload.breaking.durationSeconds === 'number'
              ? payload.breaking.durationSeconds
              : payload.breaking.tickerSpeedSeconds);
      }
      if (payload.live && typeof payload.live === 'object') {
        payload.live.tickerSpeedSeconds = typeof payload.live.speedSec === 'number' ? payload.live.speedSec : 12;
        payload.live.durationSec = typeof payload.live.durationSec === 'number'
          ? payload.live.durationSec
          : (typeof payload.live.durationSeconds === 'number'
              ? payload.live.durationSeconds
              : payload.live.tickerSpeedSeconds);
      }
    }
    return res.status(200).json(payload);
  } catch (e) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast');
  }
});

// GET /api/public/broadcast/items?type=breaking|live
router.get('/items', async (req, res) => {
  try {
    _noStore(res);

    const version = await getBroadcastVersion().catch(() => 0);
    const type = normalizeChannel((req.query && req.query.type) || (req.query && req.query.kind));
    if (!type) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid type. Expected breaking|live');
    }

    const requestedLang = _requestedLangFromReq(req);

    const itemsBy = await listItemsLast24hByChannel();
    const items = (itemsBy && itemsBy[type]) || [];
    if (_wantsDetailed(req)) {
      return res.status(200).json({ ok: true, version, items: items.map(i => _mapPublicItem(i, { lang: requestedLang })) });
    }

    if (requestedLang) {
      return res.status(200).json({ ok: true, version, items: items.map(i => _resolvePublicItemText(i, requestedLang)).filter(Boolean) });
    }

    return res.status(200).json({ ok: true, version, items: items.map(i => String(i.text || '')).filter(Boolean) });
  } catch (_) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast items');
  }
});

// GET /api/public/broadcast/settings
router.get('/settings', async (_req, res) => {
  try {
    _noStore(res);
    const version = await getBroadcastVersion().catch(() => 0);
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);
    return res.status(200).json({ ok: true, version, settings });
  } catch (_) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast settings');
  }
});

// GET /api/public/broadcast/config
// Also mounted at /public/broadcast/config via server mount.
router.get('/config', async (_req, res) => {
  try {
    _noStore(res);
    const version = await getBroadcastVersion().catch(() => 0);
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);
    const itemsBy = await listItemsLast24hByChannel();

    const breakingItems = Array.isArray(itemsBy?.breaking) ? itemsBy.breaking : [];
    const liveItems = Array.isArray(itemsBy?.live) ? itemsBy.live : [];

    const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
    const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

    return res.status(200).json({
      version,
      breaking: {
        enabled: Boolean(breakingEnabled),
        mode: settings.breaking.mode,
        // Canonical API field
        durationSec: settings.breaking.durationSec,
        // compatibility
        durationSeconds: settings.breaking.durationSeconds,
        tickerSpeedSeconds: settings.breaking.tickerSpeedSeconds,
        scrollDurationSeconds: settings.breaking.durationSeconds,
      },
      live: {
        enabled: Boolean(liveEnabled),
        mode: settings.live.mode,
        // Canonical API field
        durationSec: settings.live.durationSec,
        durationSeconds: settings.live.durationSeconds,
        tickerSpeedSeconds: settings.live.tickerSpeedSeconds,
        scrollDurationSeconds: settings.live.durationSeconds,
      },
    });
  } catch (_) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast config');
  }
});

// GET /api/public/broadcast/stream?lang=en
// Also mounted at /public/broadcast/stream?lang=en via server mount.
router.get('/stream', async (req, res) => {
  const lang = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang')
    ? _normalizeLang(req.query && req.query.lang, 'gu')
    : 'gu';

  _noStore(res);

  addClient({ res, lang });

  // Send initial state immediately.
  try {
    const snapshot = await buildBroadcastSnapshot({ lang });
    res.write('event: broadcast_updated\n');
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } catch (_) {
    // Keep stream open even if initial load fails.
    try {
      res.write('event: broadcast_updated\n');
      res.write(`data: ${JSON.stringify({ version: 0, breaking: { enabled: false, mode: 'auto', durationSeconds: 12, items: [] }, live: { enabled: false, mode: 'auto', durationSeconds: 12, items: [] } })}\n\n`);
    } catch (_) {}
  }
});

module.exports = router;
