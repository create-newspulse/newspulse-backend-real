const express = require('express');
const News = require('../models/News');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const router = express.Router();

// Frontend expects:
// GET /dashboard-stats -> { ok: true, stats: { totalArticles, totalUsers, totalViews, recentActivity, timestamp } }
// GET /stats -> same shape (alias)
// NOTE: Replace mock values with real DB queries for users/views/activity when available.

async function buildStats() {
  try {
    const [totalArticles, totalUsers, viewsAgg, recentActivity] = await Promise.all([
      News.countDocuments({}),
      User.countDocuments({}),
      News.aggregate([{ $group: { _id: null, total: { $sum: '$views' } } }]),
      ActivityLog.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    const totalViews = viewsAgg.length ? viewsAgg[0].total : 0;
    return {
      totalArticles,
      totalUsers,
      totalViews,
      recentActivity: recentActivity.map(r => ({ type: r.type, email: r.email, at: r.createdAt, meta: r.meta })),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[buildStats] error', err?.message || err);
    return {
      totalArticles: 0,
      totalUsers: 0,
      totalViews: 0,
      recentActivity: [],
      timestamp: new Date().toISOString(),
    };
  }
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
