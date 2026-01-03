
const express = require('express');
const mongoose = require('mongoose');

const TrendingTopic = require('../models/TrendingTopic');
const { DEFAULT_TRENDING_TOPICS, ensureTrendingTopicsSeeded } = require('../lib/trendingTopics');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function getDefaultItems() {
  return (DEFAULT_TRENDING_TOPICS || []).map((t, idx) => ({
    key: String(t.key || '').trim().toLowerCase(),
    label: String(t.label || '').trim(),
    href: String(t.href || '').trim(),
    colorKey: String(t.colorKey || '').trim(),
    order: idx,
    enabled: true,
  }));
}

// GET /api/public/trending-topics
router.get('/', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    if (!isDbReady()) {
      return res.status(200).json({
        success: true,
        data: { items: getDefaultItems(), source: 'default' },
      });
    }

    // Best-effort seeding (idempotent when topics already exist).
    try {
      await ensureTrendingTopicsSeeded();
    } catch (_) {}

    const items = await TrendingTopic.find({ enabled: true })
      .select('key label href colorKey order enabled')
      .sort({ order: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: { items: items || [], source: 'db' },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

module.exports = router;
