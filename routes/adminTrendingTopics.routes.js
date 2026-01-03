const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const TrendingTopic = require('../models/TrendingTopic');
const { resetTrendingTopicsToDefaults } = require('../lib/trendingTopics');

const router = express.Router();

function requireDb(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      ok: false,
      success: false,
      status: 503,
      code: 'DB_UNAVAILABLE',
      message: 'Database not connected',
    });
  }
  return next();
}

// GET /api/admin/trending-topics
router.get('/', requireAdminAuth, requireDb, async (req, res) => {
  try {
    const topics = await TrendingTopic.find({}).sort({ order: 1, _id: 1 }).lean();
    return res.json({ success: true, data: topics });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

// PUT /api/admin/trending-topics
// Body can be either an array of topics or { topics: [...] }
router.put('/', requireAdminAuth, requireDb, async (req, res) => {
  try {
    const raw = Array.isArray(req.body) ? req.body : req.body?.topics;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ success: false, message: 'topics array required' });
    }

    const normalized = raw
      .map((t, idx) => {
        const key = String(t?.key || '').trim().toLowerCase();
        const label = String(t?.label || '').trim();
        const href = String(t?.href || '').trim();
        const colorKey = String(t?.colorKey || '').trim();
        const enabled = t?.enabled === undefined ? true : !!t.enabled;
        const order = Number.isFinite(Number(t?.order)) ? Number(t.order) : idx;
        return { key, label, href, colorKey, enabled, order };
      })
      .filter((t) => t.key && t.label && t.href && t.colorKey);

    if (normalized.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid topics provided' });
    }

    // Replace-all semantics keeps ordering deterministic and simple.
    await TrendingTopic.deleteMany({});
    await TrendingTopic.insertMany(normalized, { ordered: true });

    const topics = await TrendingTopic.find({}).sort({ order: 1, _id: 1 }).lean();
    return res.json({ success: true, data: topics });
  } catch (e) {
    // Common failure: duplicate key index.
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

// POST /api/admin/trending-topics/reset
router.post('/reset', requireAdminAuth, requireDb, async (_req, res) => {
  try {
    const out = await resetTrendingTopicsToDefaults();
    const topics = await TrendingTopic.find({}).sort({ order: 1, _id: 1 }).lean();
    return res.json({ success: true, meta: out, data: topics });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

module.exports = router;
