const Article = require('../models/Article');
const { CATEGORY_VALUES, LANGUAGE_VALUES } = require('../models/Article');
const mongoose = require('mongoose');

function parseBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'n'].includes(s)) return false;
  return undefined;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSlug(slug) {
  return String(slug || '').trim().toLowerCase();
}

function shouldDeferToAdminArticlesRouter(req) {
  // If an authenticated admin calls /api/articles with CMS/admin params,
  // let the CMS/admin router handle it (mounted separately).
  if (!req.admin) return false;

  const statusRaw = String(req.query.status || '').trim().toLowerCase();
  if (statusRaw) {
    const parts = statusRaw.split(',').map(s => s.trim()).filter(Boolean);
    const hasNonFeedStatus = parts.some(s => !['draft', 'published'].includes(s));
    if (hasNonFeedStatus) return true;
  }

  // CMS/admin params
  if (req.query.sort !== undefined) return true;
  if (req.query.from !== undefined || req.query.to !== undefined) return true;
  if (req.query.language !== undefined) return true;

  return false;
}

async function listArticles(req, res, next) {
  try {
    // If this request looks like an admin/CMS list request, defer to the CMS router.
    if (shouldDeferToAdminArticlesRouter(req)) return next();

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const lang = String(req.query.lang || '').trim().toLowerCase();
    const isBreaking = parseBool(req.query.isBreaking);

    const state = String(req.query.state || '').trim();
    const district = String(req.query.district || '').trim();
    const city = String(req.query.city || '').trim();

    const q = String(req.query.q || '').trim();

    const filter = {};

    // Public feed is published-only.
    if (statusRaw && statusRaw !== 'published') {
      return res.status(400).json({ message: 'Only status=published is allowed' });
    }
    filter.status = 'published';

    if (category) {
      if (!CATEGORY_VALUES.includes(category)) {
        return res.status(400).json({ message: 'Invalid category' });
      }
      filter.category = category;
    }

    if (lang) {
      if (!LANGUAGE_VALUES.includes(lang)) {
        return res.status(400).json({ message: 'Invalid lang (use en, hi, gu)' });
      }
      filter.language = lang;
    }

    if (isBreaking !== undefined) filter.isBreaking = isBreaking;

    if (state) filter.state = state;
    if (district) filter.district = district;
    if (city) filter.city = city;

    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [
        { title: rx },
        { summary: rx },
        { content: rx },
        { tags: rx },
      ];
    }

    const skip = (page - 1) * limit;

    const sort = { publishedAt: -1, createdAt: -1 };

    const [items, total] = await Promise.all([
      Article.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Article.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.json({ items, page, limit, total, totalPages });
  } catch (e) {
    return next(e);
  }
}

async function getArticleBySlug(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }
    const slug = normalizeSlug(req.params.slug);

    // If this looks like a Mongo ObjectId, defer to other routers.
    if (/^[0-9a-f]{24}$/i.test(slug)) return next();

    const filter = { slug, status: 'published' };

    const doc = await Article.findOne(filter).lean();
    if (!doc) {
      return res.status(404).json({ message: 'Article not found' });
    }

    return res.json(doc);
  } catch (e) {
    return next(e);
  }
}

module.exports = { listArticles, getArticleBySlug };
