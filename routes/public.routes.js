const express = require('express');
const mongoose = require('mongoose');

// "Stories" in this backend map to the public Article model.
// If your frontend uses a different shape/model, tell me and I’ll swap it.
const Article = require('../models/Article');
const { getSlugCandidates } = require('../lib/slug');

const router = express.Router();

function isDbConnected() {
  // 1 = connected
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// GET: /api/public/stories?category=&lang=&limit=20&page=1
router.get('/stories', async (req, res) => {
  try {
    const { category, lang, limit = 20, page = 1 } = req.query;

    if (!isDbConnected()) {
      return res.json({ success: true, data: [], message: 'Database unavailable' });
    }

    const q = { status: 'published' };
    if (category) q.category = String(category);
    if (lang) q.language = String(lang);

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * lim;

    const stories = await Article.find(q)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    return res.json({ success: true, data: stories });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// GET: /api/public/stories/:slug
router.get('/stories/:slug', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(200).json({ success: false, message: 'Database unavailable' });
    }

    const candidates = getSlugCandidates(req.params.slug);
    if (!candidates.length) {
      return res.status(400).json({ success: false, message: 'Missing slug' });
    }

    const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
    const story = await Article.findOne({ slug: slugFilter, status: 'published' }).lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }

    return res.json({ success: true, data: story });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

module.exports = router;
