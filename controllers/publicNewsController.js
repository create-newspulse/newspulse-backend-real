const mongoose = require('mongoose');

const News = require('../models/News');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeSlugOrId(v) {
  return String(v || '').trim();
}

function isObjectIdLike(v) {
  return /^[0-9a-f]{24}$/i.test(String(v || '').trim());
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPublicPublishedFilter({ category, q }) {
  const now = new Date();

  const filter = {
    status: 'published',
    $and: [
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: now } }] },
    ],
  };

  if (category) filter.category = category;

  if (q) {
    const safe = escapeRegExp(q);
    // Regex search is simple but can be slow on large collections; keep it bounded.
    const rx = new RegExp(safe, 'i');
    filter.$and.push({
      $or: [
        { title: rx },
        { summary: rx },
        { description: rx },
        { content: rx },
      ],
    });
  }

  return filter;
}

const PUBLIC_SELECT = [
  'title',
  'description',
  'content',
  'slug',
  'tags',
  'category',
  'language',
  'imageURL',
  'coverImageUrl',
  'publishedAt',
  'date',
  'createdAt',
  'updatedAt',
].join(' ');

function withCoverImageUrl(obj) {
  const out = { ...(obj || {}) };
  out.coverImageUrl = out.coverImageUrl || out.imageURL || null;
  return out;
}

// GET /api/public/news?category=&q=&limit=30&page=1
async function listPublicNews(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);

    const category = String(req.query.category || '').trim();

    let q = String(req.query.q || '').trim();
    // Keep keyword search safe and bounded
    if (q.length > 80) q = q.slice(0, 80);

    if (!isDbReady()) {
      return res.status(200).json({ items: [], page, limit, total: 0, totalPages: 1 });
    }

    const filter = buildPublicPublishedFilter({
      category: category || undefined,
      q: q || undefined,
    });

    const skip = (page - 1) * limit;
    const sort = { publishedAt: -1, createdAt: -1 };

    const [itemsRaw, total] = await Promise.all([
      News.find(filter).select(PUBLIC_SELECT).sort(sort).skip(skip).limit(limit).lean(),
      News.countDocuments(filter),
    ]);

    const items = (itemsRaw || []).map(withCoverImageUrl);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({ items, page, limit, total, totalPages });
  } catch (e) {
    return res.status(500).json({ items: [], page: 1, limit: 30, total: 0, totalPages: 1, message: e?.message || String(e) });
  }
}

// GET /api/public/news/:slugOrId
async function getPublicNewsBySlugOrId(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const slugOrIdRaw = normalizeSlugOrId(req.params.slugOrId);
    if (!slugOrIdRaw) {
      return res.status(404).json({ message: 'Not found' });
    }

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    const base = buildPublicPublishedFilter({});
    let doc = null;

    if (isObjectIdLike(slugOrIdRaw)) {
      doc = await News.findOne({ ...base, _id: slugOrIdRaw }).select(PUBLIC_SELECT).lean();
    } else {
      const slug = slugOrIdRaw.toLowerCase();
      doc = await News.findOne({ ...base, slug }).select(PUBLIC_SELECT).lean();
    }

    if (!doc) {
      return res.status(404).json({ message: 'Not found' });
    }

    return res.status(200).json(withCoverImageUrl(doc));
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

module.exports = {
  listPublicNews,
  getPublicNewsBySlugOrId,
};
