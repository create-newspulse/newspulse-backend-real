const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  getOrCreateSettings,
  adminSettingsResponse,
  patchSettings,
  listItemsLast24hByChannel,
  createItem,
  deleteItemById,
  normalizeChannel,
} = require('../services/broadcastCenter.service');

const router = express.Router();

function ensureDbOr503(res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ ok: false, message: 'Database unavailable' });
    return false;
  }
  return true;
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

function mapItem(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const id = d._id ? String(d._id) : undefined;
  return {
    id,
    type: d.type === 'breaking' || d.type === 'live' ? d.type : undefined,
    text: typeof d.text === 'string' ? d.text : '',
    createdAt: d.createdAt || null,
  };
}

// Admin APIs (protected)
// GET /api/admin/broadcast
router.get('/', requireAdminAuth, async (_req, res) => {
  if (!ensureDbOr503(res)) return;

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  return res.status(200).json(toAdminContract(settings));
});

// PUT /api/admin/broadcast
router.put('/', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await patchSettings(buildPatchPayload(body));
  if (!result.ok) {
    return res.status(result.status).json({ ok: false, message: result.message });
  }

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  return res.status(200).json(toAdminContract(settings));
});

// GET /api/admin/broadcast/items?type=breaking|live
router.get('/items', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const type = normalizeChannel(req.query && req.query.type);
  if (!type) {
    return res.status(400).json({ ok: false, message: 'Invalid type. Expected breaking|live' });
  }

  const itemsBy = await listItemsLast24hByChannel();
  const items = (itemsBy && itemsBy[type]) || [];
  return res.status(200).json(items.map(mapItem));
});

// POST /api/admin/broadcast/items  body { type, text }
router.post('/items', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const type = normalizeChannel(body.type);
  if (!type) {
    return res.status(400).json({ ok: false, message: 'Invalid type. Expected breaking|live' });
  }

  const created = await createItem(type, body.text);
  if (!created.ok) {
    return res.status(created.status).json({ ok: false, message: created.message });
  }

  return res.status(201).json(mapItem(created.item));
});

// DELETE /api/admin/broadcast/items/:id
router.delete('/items/:id', requireAdminAuth, async (req, res) => {
  if (!ensureDbOr503(res)) return;

  const result = await deleteItemById(req.params.id);
  if (!result.ok) {
    return res.status(result.status).json({ ok: false, message: result.message });
  }

  return res.status(200).json({ ok: true });
});

module.exports = router;
