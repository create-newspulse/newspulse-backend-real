const express = require('express');
const News = require('../models/News');
const router = express.Router();

// Frontend expects:
// GET /dashboard-stats -> { ok: true, stats: { totalArticles, totalUsers, totalViews, recentActivity, timestamp } }
// GET /stats -> same shape (alias)
// NOTE: Replace mock values with real DB queries for users/views/activity when available.

async function buildStats() {
  let totalArticles = 0;
  try {
    // Will return 0 if Mongo not connected yet
    totalArticles = await News.countDocuments({});
  } catch (_) {}
  return {
    totalArticles,
    totalUsers: 1, // TODO: replace with real user/admin count
    totalViews: 0, // TODO: track & aggregate view counts
    recentActivity: [], // TODO: populate with recent actions/logs
    timestamp: new Date().toISOString(),
  };
}

router.get('/dashboard-stats', async (req, res) => {
  try {
    const stats = await buildStats();
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error('[dashboard-stats] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load dashboard stats' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await buildStats();
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error('[stats] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load stats' });
  }
});

module.exports = router;
