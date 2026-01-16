const express = require('express');

const {
  computePublicPayload,
  listItemsLast24hByChannel,
  normalizeChannel,
  getOrCreateSettings,
  adminSettingsResponse,
} = require('../services/broadcastCenter.service');

const router = express.Router();

// GET /api/public/broadcast
router.get('/', async (_req, res) => {
  try {
    const payload = await computePublicPayload();
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast' });
  }
});

// GET /api/public/broadcast/items?type=breaking|live
router.get('/items', async (req, res) => {
  try {
    const type = normalizeChannel(req.query && req.query.type);
    if (!type) {
      return res.status(400).json({ ok: false, message: 'Invalid type. Expected breaking|live' });
    }

    const itemsBy = await listItemsLast24hByChannel();
    const items = (itemsBy && itemsBy[type]) || [];
    return res.status(200).json({ ok: true, items: items.map(i => String(i.text || '')).filter(Boolean) });
  } catch (_) {
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast items' });
  }
});

// GET /api/public/broadcast/settings
router.get('/settings', async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    const settings = adminSettingsResponse(doc);
    return res.status(200).json({ ok: true, settings });
  } catch (_) {
    return res.status(500).json({ ok: false, message: 'Failed to load broadcast settings' });
  }
});

module.exports = router;
