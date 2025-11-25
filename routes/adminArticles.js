const express = require('express');
const News = require('../models/News');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// Helper: build Mongo filter from query params
function buildFilter(query) {
  const {
    status,
    category,
    language,
    search,
    from,
    to,
  } = query || {};
  const filter = {};

  if (status && status !== 'all') {
    // allow comma separated list
    const parts = String(status).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 1) filter.status = parts[0];
    else if (parts.length > 1) filter.status = { $in: parts };
  }
  if (category && category !== 'all') {
    filter.category = String(category).trim();
  }
  if (language && language !== 'all') {
    filter.language = String(language).trim();
  }
  // date range filters apply to `date` field (creation/publish date in existing schema)
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (fromDate && !isNaN(fromDate)) {
    filter.date = filter.date || {};
    filter.date.$gte = fromDate;
  }
  if (toDate && !isNaN(toDate)) {
    filter.date = filter.date || {};
    filter.date.$lte = toDate;
  }
  if (search) {
    const term = String(search).trim();
    if (term) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { title: regex },
        { description: regex },
        { content: regex },
      ];
    }
  }
  return filter;
}

// GET /api/admin/articles
// NOTE: mounted under /api/admin so path becomes /api/admin/articles
router.get('/articles', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * pageSize;

    const filter = buildFilter(req.query);

    const sortRaw = (req.query.sort || '-date').toString();
    const sort = {};
    sortRaw.split(',').forEach(part => {
      part = part.trim();
      if (!part) return;
      if (part.startsWith('-')) sort[part.slice(1)] = -1; else sort[part] = 1;
    });

    const [items, total] = await Promise.all([
      News.find(filter).sort(sort).skip(skip).limit(pageSize).lean(),
      News.countDocuments(filter),
    ]);

    return res.json({ ok: true, success: true, items, total, page, pageSize });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][list-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load articles' });
  }
});

// POST /api/admin/articles
router.post('/articles', requireAdminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const allowedStatuses = new Set(['draft','scheduled','published','archived','deleted']);
    let {
      title,
      summary,
      description,
      content,
      tags,
      category,
      status,
      language,
      scheduledAt,
      imageURL,
    } = body;

    if (!title) {
      return res.status(400).json({ ok: false, success: false, message: 'Title is required' });
    }

    if (status && !allowedStatuses.has(status)) {
      status = 'draft'; // fall back to schema default
    }

    if (scheduledAt) {
      const dt = new Date(scheduledAt);
      if (!isNaN(dt)) scheduledAt = dt; else scheduledAt = undefined;
    }

    const article = new News({
      title,
      description: description ?? summary ?? '',
      content,
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      category,
      status: status || 'draft',
      language: language || 'en',
      scheduledAt,
      imageURL,
    });

    await article.save();

    return res.status(201).json({ ok: true, success: true, article });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][create-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to create article' });
  }
});

module.exports = router;
