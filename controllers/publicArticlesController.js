const Article = require('../models/Article');
const { CATEGORY_VALUES, LANGUAGE_VALUES } = require('../models/Article');
const mongoose = require('mongoose');
const { getSlugCandidates } = require('../lib/slug');
const {
  normalizeLocale,
  getRequestedLocale,
  parseAllowFallback,
  localizeDocStrict,
} = require('../services/publicStoryLocale.service');
const {
  buildPubliclyVisiblePublicArticleFilter,
  getAvailableArticleLocales,
} = require('../services/publicArticleVisibility.service');
const {
  buildLocaleEligibilityMatch,
  dedupeLocalizedByStoryGroup,
  localizeAndShapeListItem,
  removeInternalPublicFields,
} = require('../services/publicStoryGroupResolver.service');

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

function normalizeLanguage(v) {
  // Keep backward-compat for existing callers, but prefer shared normalizeLocale().
  return normalizeLocale(v);
}

function normalizeSlug(slug) {
  // Keep backward-compat callers, but normalize via candidate logic.
  const c = getSlugCandidates(slug);
  return c[0] || '';
}

function shouldDeferToAdminArticlesRouter(req) {
  // If an authenticated admin calls /api/articles with non-feed params,
  // let the existing CMS/admin router handle it.
  if (!req.admin) return false;

  const statusRaw = String(req.query.status || '').trim().toLowerCase();
  if (statusRaw) {
    const parts = statusRaw.split(',').map(s => s.trim()).filter(Boolean);
    const hasNonFeedStatus = parts.some(s => !['draft', 'published'].includes(s));
    if (hasNonFeedStatus) return true;
  }

  // Legacy/CMS params
  if (req.query.sort !== undefined) return true;
  if (req.query.from !== undefined || req.query.to !== undefined) return true;
  if (req.query.language !== undefined) return true;

  return false;
}

async function listArticles(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }
    if (shouldDeferToAdminArticlesRouter(req)) return next();

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const explicitLangRaw = String(req.query.lang || req.query.language || '').trim();
    if (explicitLangRaw && !normalizeLocale(explicitLangRaw)) {
      return res.status(400).json({ message: 'Invalid lang (use en, hi, gu)' });
    }

    // Default locale for public feed is EN (strict).
    const requestedLocale = getRequestedLocale(req, { defaultLocale: 'en' });
    const fallbackTo = parseAllowFallback(req);
    const isBreaking = parseBool(req.query.isBreaking);

    const state = String(req.query.state || '').trim();
    const district = String(req.query.district || '').trim();
    const city = String(req.query.city || '').trim();

    const q = String(req.query.q || '').trim();

    const filter = buildPubliclyVisiblePublicArticleFilter();

    // Public feed is published-only.
    if (statusRaw && statusRaw !== 'published') {
      return res.status(400).json({ message: 'Only status=published is allowed' });
    }
    // already enforced by buildPubliclyVisiblePublicArticleFilter()

    if (category) {
      if (!CATEGORY_VALUES.includes(category)) {
        return res.status(400).json({ message: 'Invalid category' });
      }
      filter.category = category;
    }

    // Always enforce strict locale eligibility even when ?lang is omitted.
    // This prevents Gujarati/Hindi originals leaking on EN routes.
    const eligibility = buildLocaleEligibilityMatch(requestedLocale);
    filter.$and = Array.isArray(filter.$and) ? filter.$and : [];
    if (eligibility) filter.$and.push(eligibility);

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

    // Over-fetch to account for locale exclusions + group dedupe.
    const queryLimit = Math.min(limit * 5, 250);

    const [itemsRaw, total] = await Promise.all([
      Article.find(filter).sort(sort).skip(skip).limit(queryLimit).lean(),
      Article.countDocuments(filter),
    ]);

    const localized = (itemsRaw || [])
      .map((doc) => localizeAndShapeListItem(doc, requestedLocale, {
        fallbackTo,
        logger: console,
        logContext: { endpoint: 'GET /api/articles', category: category || null },
      }))
      .filter(Boolean);

    // Dedupe to one record per canonical story group.
    let items = dedupeLocalizedByStoryGroup(localized)
      .sort((a, b) => {
        const at = a.publishedAt ? new Date(a.publishedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return bt - at;
      })
      .slice(0, limit)
      .map(removeInternalPublicFields);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.json({ items, page, limit, total, totalPages });
  } catch (e) {
    return next(e);
  }
}

async function getArticleBySlug(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database not connected' });
    }
    const candidates = getSlugCandidates(req.params.slug);
    const slug = candidates[0] || '';

    // If this looks like a Mongo ObjectId, defer to the existing /api/articles/:id route.
    if (/^[0-9a-f]{24}$/i.test(slug)) return next();

    const slugFilter = candidates.length === 1 ? slug : { $in: candidates };
    const filter = {
      status: 'published',
      $or: [
        { slug: slugFilter },
        { 'slugs.en': slugFilter },
        { 'slugs.hi': slugFilter },
        { 'slugs.gu': slugFilter },
      ],
    };

    const doc = await Article.findOne(filter).lean();
    if (!doc) {
      return res.status(404).json({ message: 'Article not found' });
    }

    const explicitLangRaw = String(req.query.lang || req.query.language || '').trim();
    if (explicitLangRaw && !normalizeLocale(explicitLangRaw)) {
      return res.status(400).json({ message: 'Invalid lang (use en, hi, gu)' });
    }

    const requestedLocale = getRequestedLocale(req, { defaultLocale: 'en' });
    const fallbackTo = parseAllowFallback(req);

    const localized = localizeDocStrict(doc, requestedLocale, {
      mode: 'detail',
      fallbackTo,
      logger: console,
      logContext: { endpoint: 'GET /api/articles/:slug' },
    });

    if (!localized) {
      return res.status(404).json({
        message: 'Article not available in requested language',
        requestedLang: requestedLocale,
        availableLocales: getAvailableArticleLocales(doc),
      });
    }

    const target = localized.selectedLocale || requestedLocale;
    const canonicalSlug = (doc.slugs && doc.slugs[target]) ? doc.slugs[target] : (doc.slug || null);

    const out = removeInternalPublicFields({
      ...localized,
      canonicalSlug,
      availableLocales: getAvailableArticleLocales(doc),
    });

    return res.json(out);
  } catch (e) {
    return next(e);
  }
}

module.exports = { listArticles, getArticleBySlug };
