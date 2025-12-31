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

function normalizeCategorySlug(v) {
  return String(v || '').trim().toLowerCase();
}

function parseTruthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function getRequestedLang(req) {
  // Canonical param is `lang`, but accept `language` for backward compatibility.
  return normalizeLanguage(req.query.lang) || normalizeLanguage(req.query.language) || null;
}

function buildPublicPublishedFilter({ category, q, founderOnly, type }) {
  const now = new Date();

  const filter = {
    $and: [
      // Compatibility: some collections use status/workflowStage, others use a boolean.
      {
        $or: [
          { published: true },
          { status: 'published' },
          { status: { $regex: '^published$', $options: 'i' } },
          { workflowStage: 'published' },
          { workflowStage: 'PUBLISHED' },
        ],
      },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: now } }] },
    ],
  };

  if (category) filter.category = category;

  if (founderOnly) {
    filter.$and.push({
      $or: [
        { isFounder: true },
        { authorRole: { $regex: '^FOUNDER$', $options: 'i' } },
        // Works for both string and array-valued fields.
        { authorTag: { $regex: 'Founder', $options: 'i' } },
      ],
    });
  }

  if (type === 'video') {
    filter.$and.push({
      $or: [
        { contentType: { $regex: '^video$', $options: 'i' } },
        { mediaType: { $regex: '^video$', $options: 'i' } },
        { postType: { $regex: '^video$', $options: 'i' } },
        { videoUrl: { $exists: true, $ne: '' } },
      ],
    });
  }

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
  'lang',
  'language',
  'translationGroupId',
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
  out.lang = out.lang || out.language || 'en';
  out.language = out.language || out.lang || 'en';
  return out;
}

// GET /api/public/news?category=&type=video&founderOnly=true&limit=30&page=1
async function listPublicNews(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);

    const category = normalizeCategorySlug(req.query.category);
    const founderOnly = parseTruthy(req.query.founderOnly);
    const type = String(req.query.type || '').trim().toLowerCase();

    const lang = getRequestedLang(req);

    let q = String(req.query.q || '').trim();
    // Keep keyword search safe and bounded
    if (q.length > 80) q = q.slice(0, 80);

    if (!isDbReady()) {
      return res.status(200).json({ items: [], page, limit, total: 0, totalPages: 1 });
    }

    const filter = buildPublicPublishedFilter({
      category: category || undefined,
      q: q || undefined,
      founderOnly,
      type,
    });

    if (lang) {
      // Backward compatibility: treat missing language/lang as "en".
      if (lang === 'en') {
        filter.$and.push({
          $or: [
            { lang: 'en' },
            { language: 'en' },
            { lang: null },
            { language: null },
            { lang: { $exists: false } },
            { language: { $exists: false } },
          ],
        });
      } else {
        filter.$and.push({ $or: [{ lang }, { language: lang }] });
      }
    }

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

// GET /api/public/news/translations/:translationGroupId
async function listPublicNewsTranslations(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const translationGroupId = String(req.params.translationGroupId || '').trim();
    if (!translationGroupId) return res.status(200).json([]);

    if (!isDbReady()) {
      return res.status(200).json([]);
    }

    const filter = buildPublicPublishedFilter({});
    filter.$and.push({ translationGroupId });

    const itemsRaw = await News.find(filter)
      .select(PUBLIC_SELECT)
      .sort({ language: 1, publishedAt: -1, createdAt: -1 })
      .lean();

    const items = (itemsRaw || []).map(withCoverImageUrl);
    return res.status(200).json(items);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
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
  listPublicNewsTranslations,
  getPublicNewsBySlugOrId,
};
