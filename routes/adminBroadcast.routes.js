const express = require('express');
const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
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

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, success: false, status, code, message });
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

  const type = Object.prototype.hasOwnProperty.call(req.query || {}, 'type')
    ? normalizeChannel(req.query && req.query.type)
    : null;
  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'type') && !type) {
    return fail(res, 400, 'INVALID_TYPE', 'Invalid type. Expected breaking|live');
  }

  const itemsBy = await listItemsLast24hByChannel();
  if (type) {
    const items = (itemsBy && itemsBy[type]) || [];
    return ok(res, items.map(mapItem));
  }

  const all = []
    .concat((itemsBy && itemsBy.breaking) || [])
    .concat((itemsBy && itemsBy.live) || [])
    .sort((a, b) => {
      const at = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bt - at;
    });

  return ok(res, all.map(mapItem));
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

  const created = await createItem(type, body.text);
  if (!created.ok) {
    const status = typeof created.status === 'number' ? created.status : 400;
    const code = status === 503 ? 'DB_UNAVAILABLE' : 'BAD_REQUEST';
    return fail(res, status, code, created.message || 'Invalid request');
  }

  return res.status(201).json({ ok: true, success: true, data: mapItem(created.item) });
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
