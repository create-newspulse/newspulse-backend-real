const express = require('express');

const {
  computePublicPayload,
  listItemsLast24hByChannel,
  normalizeChannel,
  getOrCreateSettings,
  adminSettingsResponse,
} = require('../services/broadcastCenter.service');

const router = express.Router();

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
  if (_wantsDetailed(req)) {
    try {
      _noStore(res);
      const doc = await getOrCreateSettings();
      const settings = adminSettingsResponse(doc);
      const itemsBy = await listItemsLast24hByChannel();

      const breakingItems = Array.isArray(itemsBy.breaking) ? itemsBy.breaking : [];
      const liveItems = Array.isArray(itemsBy.live) ? itemsBy.live : [];

      return res.status(200).json({
        breaking: {
          enabled: Boolean(settings.breaking.enabled),
          mode: settings.breaking.mode,
          speed: settings.breaking.speedSec,
          speedSec: settings.breaking.speedSec,
          items: breakingItems.map(_mapPublicItem),
        },
        live: {
          enabled: Boolean(settings.live.enabled),
          mode: settings.live.mode,
          speed: settings.live.speedSec,
          speedSec: settings.live.speedSec,
          items: liveItems.map(_mapPublicItem),
        },
      });
    } catch (_) {
      _noStore(res);
      return res.status(500).json({ ok: false, message: 'Failed to load broadcast' });
    }
  }

  try {
    _noStore(res);
    const payload = await computePublicPayload();
    return res.status(200).json(payload);
  } catch (e) {
    _noStore(res);
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast' });
  }
});

// GET /api/public/broadcast/items?type=breaking|live
router.get('/items', async (req, res) => {
  try {
    _noStore(res);
    const type = normalizeChannel(req.query && req.query.type);
    if (!type) {
      return res.status(400).json({ ok: false, message: 'Invalid type. Expected breaking|live' });
    }

    const itemsBy = await listItemsLast24hByChannel();
    const items = (itemsBy && itemsBy[type]) || [];
    if (_wantsDetailed(req)) {
      return res.status(200).json({ ok: true, items: items.map(_mapPublicItem) });
    }
    return res.status(200).json({ ok: true, items: items.map(i => String(i.text || '')).filter(Boolean) });
  } catch (_) {
    _noStore(res);
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast items' });
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
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast settings' });
  }
});

module.exports = router;
