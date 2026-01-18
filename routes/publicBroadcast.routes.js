const express = require('express');

const {
  computePublicPayload,
  listItemsLast24hByChannel,
  normalizeChannel,
  getOrCreateSettings,
  adminSettingsResponse,
  computeEffectiveEnabled,
} = require('../services/broadcastCenter.service');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function _normalizeLang(v, fallback = 'gu') {
  const s = String(v || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(s) ? s : fallback;
}

function _resolvePublicItemText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = _normalizeLang(lang, 'gu');
  const src = SUPPORTED_LANGS.has(String(d.sourceLang || '')) ? String(d.sourceLang) : null;
  const by = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const status = d.statusByLang && typeof d.statusByLang === 'object' ? d.statusByLang : null;

  // Safety rule: only show a translation when it's explicitly APPROVED.
  if (by && status && status[target] === 'APPROVED' && typeof by[target] === 'string' && by[target].trim()) {
    return String(by[target]).trim();
  }

  const fallback =
    (src && by && typeof by[src] === 'string' && by[src].trim() ? by[src] : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');
  return String(fallback || '').trim();
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
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } catch (_) {}
}

function _wantsDetailed(req) {
  const q = (req && req.query) || {};
  const v = String(q.detailed || q.detail || q.full || q.v || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === '2' || v === 'full';
}

function _mapPublicItem(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  return {
    id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    text: typeof d.text === 'string' ? d.text : '',
    createdAt: d.createdAt || null,
    expiresAt: d.expiresAt || null,
  };
}

// GET /api/public/broadcast
// Default: stable payload used by the website.
// Optional: detailed payload (query ?detailed=1) with item objects + id mapping.
router.get('/', async (req, res) => {
  const requestedLang = Object.prototype.hasOwnProperty.call((req && req.query) || {}, 'lang')
    ? _normalizeLang(req.query && req.query.lang, 'gu')
    : null;

  // New Phase 1 contract: only when ?lang is provided.
  if (requestedLang) {
    try {
      _noStore(res);

      const doc = await getOrCreateSettings();
      const settings = adminSettingsResponse(doc);
      const itemsBy = await listItemsLast24hByChannel();

      const limit = 20;
      const breakingItems = (Array.isArray(itemsBy.breaking) ? itemsBy.breaking : [])
        .filter(i => i && i.isLive !== false)
        .slice(0, limit);
      const liveItems = (Array.isArray(itemsBy.live) ? itemsBy.live : [])
        .filter(i => i && i.isLive !== false)
        .slice(0, limit);

      const breakingEnabled = computeEffectiveEnabled(settings.breaking.enabled, settings.breaking.mode, breakingItems.length);
      const liveEnabled = computeEffectiveEnabled(settings.live.enabled, settings.live.mode, liveItems.length);

      const mapItem = (d) => {
        const id = d && d._id ? String(d._id) : undefined;
        return {
          id,
          type: d && (d.type === 'breaking' || d.type === 'live') ? d.type : undefined,
          text: _resolvePublicItemText(d, requestedLang),
          createdAt: (d && d.createdAt) || null,
        };
      };

      return res.status(200).json({
        ok: true,
        data: {
          breaking: {
            enabled: breakingEnabled,
            mode: settings.breaking.mode,
            speedSeconds: settings.breaking.speedSec,
            items: breakingItems.map(mapItem),
          },
          live: {
            enabled: liveEnabled,
            mode: settings.live.mode,
            speedSeconds: settings.live.speedSec,
            items: liveItems.map(mapItem),
          },
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

      const breakingEnabled = computeEffectiveEnabled(settings.breaking.enabled, settings.breaking.mode, breakingItems.length);
      const liveEnabled = computeEffectiveEnabled(settings.live.enabled, settings.live.mode, liveItems.length);

      return res.status(200).json({
        breaking: {
          enabled: breakingEnabled,
          mode: settings.breaking.mode,
          speed: settings.breaking.speedSec,
          speedSec: settings.breaking.speedSec,
          items: breakingItems.map(_mapPublicItem),
        },
        live: {
          enabled: liveEnabled,
          mode: settings.live.mode,
          speed: settings.live.speedSec,
          speedSec: settings.live.speedSec,
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
    const type = normalizeChannel(req.query && req.query.type);
    if (!type) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid type. Expected breaking|live');
    }

    const itemsBy = await listItemsLast24hByChannel();
    const items = (itemsBy && itemsBy[type]) || [];
    if (_wantsDetailed(req)) {
      return res.status(200).json({ ok: true, items: items.map(_mapPublicItem) });
    }
    return res.status(200).json({ ok: true, items: items.map(i => String(i.text || '')).filter(Boolean) });
  } catch (_) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast items');
  }
});

// GET /api/public/broadcast/settings
router.get('/settings', async (_req, res) => {
  try {
    _noStore(res);
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);
    return res.status(200).json({ ok: true, settings });
  } catch (_) {
    _noStore(res);
    return sendError(res, 500, 'SERVER_ERROR', 'Failed to load broadcast settings');
  }
});

module.exports = router;
