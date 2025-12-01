const express = require('express');
const News = require('../models/News');

// Router used by NewsPulse Admin Panel (/add) for Save Draft / Publish
const router = express.Router();

// Helpers
function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(Boolean).map(t => String(t).trim()).filter(Boolean);
  return String(tags)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

// POST /api/articles → create a new article
router.post('/articles', async (req, res, next) => {
  try {
    const {
      title,
      slug,
      summary,
      content,
      body,
      category,
      language,
      tags,
      status,
      scheduledAt,
      imageURL,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ ok: false, success: false, message: 'Title is required' });
    }

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const doc = await News.create({
      title,
      description: summary ?? '',
      content: content ?? body ?? '',
      category,
      language: language || 'en',
      tags: parseTags(tags),
      status: status || 'draft',
      scheduledAt: scheduled,
      imageURL,
      slug,
    });

    return res.status(201).json({ ok: true, success: true, article: doc });
  } catch (err) {
    return next(err);
  }
});

// GET /api/articles → list articles (status, page, limit)
router.get('/articles', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const status = (req.query.status || '').trim();
    const query = {};
    if (status) query.status = status;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      News.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    return res.json({ ok: true, success: true, articles: items, total, page, limit });
  } catch (err) {
    return next(err);
  }
});

// GET /api/articles/:id → get single article by id
router.get('/articles/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await News.findById(id);
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Route not found', path: req.originalUrl });
    }
    return res.json({ ok: true, success: true, article: doc });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/articles/:id → update existing article by id
router.put('/articles/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      summary,
      content,
      body,
      category,
      language,
      tags,
      status,
      scheduledAt,
      imageURL,
    } = req.body || {};

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const update = {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { description: summary } : {}),
      ...(content !== undefined || body !== undefined ? { content: content ?? body ?? '' } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(tags !== undefined ? { tags: parseTags(tags) } : {}),
      ...(status !== undefined ? { status: status || 'draft' } : {}),
      ...(scheduled !== undefined ? { scheduledAt: scheduled } : {}),
      ...(imageURL !== undefined ? { imageURL } : {}),
      ...(slug !== undefined ? { slug } : {}),
    };

    let doc = null;
    try {
      doc = await News.findByIdAndUpdate(id, update, { new: true });
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Route not found', path: req.originalUrl });
    }
    return res.json({ ok: true, success: true, article: doc });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
// DELETE /api/articles/:id → soft delete (status: 'deleted')
router.delete('/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await News.findByIdAndUpdate(
        id,
        { $set: { status: 'deleted' } },
        { new: true }
      );
    } catch (_) {
      // invalid ObjectId or other cast error -> treat as not found below
    }

    if (!doc) {
      return res
        .status(404)
        .json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    return res
      .status(200)
      .json({ ok: true, success: true, status: 200, data: doc });
  } catch (err) {
    console.error('[articles.delete] error:', err?.message || err);
    return res
      .status(500)
      .json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// DELETE /api/articles/:id/hard-delete → permanent delete (only if already deleted)
router.delete('/articles/:id/hard-delete', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await News.findById(id);
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard-delete] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// POST alias: /api/articles/:id/hard-delete (admin panel fallback)
router.post('/articles/:id/hard-delete', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try { doc = await News.findById(id); } catch (_) {}
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard-delete.post] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// POST alias: /api/articles/:id/hard (shorter legacy path)
router.post('/articles/:id/hard', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try { doc = await News.findById(id); } catch (_) {}
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard.post] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});
