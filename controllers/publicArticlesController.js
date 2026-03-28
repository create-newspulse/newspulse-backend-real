const Article = require('../models/Article');
const { CATEGORY_VALUES, LANGUAGE_VALUES } = require('../models/Article');
const mongoose = require('mongoose');
const { buildPublicCategoryFilter, getCanonicalPublicCategoryKey, isSupportedPublicCategory } = require('../lib/categories');
const { getSlugCandidates, detectSlugLocale } = require('../lib/slug');
const { mapArticleForLang, localizeArticleForLang } = require('../services/mapArticleForLang');
const {
  buildPubliclyVisiblePublicArticleFilter,
  getAvailableArticleLocales,
} = require('../services/publicArticleVisibility.service');

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
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
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
    const canonicalCategory = getCanonicalPublicCategoryKey(category);
    const lang = normalizeLanguage(req.query.lang || req.query.language || req.lang);
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
      if (!isSupportedPublicCategory(category, CATEGORY_VALUES)) {
        return res.status(400).json({ message: 'Invalid category' });
      }
      filter.category = buildPublicCategoryFilter(canonicalCategory);
    }

    if (lang) {
      if (!LANGUAGE_VALUES.includes(lang)) {
        return res.status(400).json({ message: 'Invalid lang (use en, hi, gu)' });
      }

      // English/Hindi feeds stay strict: originals in that language or fully-ready translations.
      // Gujarati must localize from the main article record and fall back to base values.
      if (lang !== 'gu') {
        const lower = lang;
        const upper = lang.toUpperCase();
        filter.$and = (filter.$and || []).concat([
          {
            $or: [
              {
                $or: [
                  { originalLang: { $in: [lower, upper] } },
                  {
                    $and: [
                      { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
                      { language: { $in: [lower, upper] } },
                    ],
                  },
                ],
              },
              {
                $and: [
                  { [`translationStatus.${lower}`]: 'ready' },
                  { [`translations.${lower}.title`]: { $exists: true, $nin: [null, ''] } },
                  { [`translations.${lower}.summary`]: { $exists: true, $nin: [null, ''] } },
                  { [`translations.${lower}.content`]: { $exists: true, $nin: [null, ''] } },
                ],
              },
            ],
          },
        ]);
      }
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

    const [itemsRaw, total] = await Promise.all([
      Article.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Article.countDocuments(filter),
    ]);

    let items = itemsRaw || [];
    if (lang) {
      items = items
        .map((doc) => {
          const mapped = localizeArticleForLang(doc, lang, { fallbackToBase: lang === 'gu' });
          if (!mapped) return null;
          return {
            ...doc,
            title: mapped.title,
            summary: mapped.summary,
            content: mapped.content,
            slug: mapped.slug,
            canonicalSlug: mapped.canonicalSlug,
            language: mapped.lang,
            requestedLang: mapped.requestedLang,
            resolvedLang: mapped.resolvedLang,
            isTranslated: mapped.isTranslated,
          };
        })
        .filter(Boolean);
    }

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

    const explicitTarget = normalizeLanguage(req.query.lang || req.query.language || req.lang);
    const target = explicitTarget || detectSlugLocale(doc, req.params.slug);
    if (target) {
      const mapped = localizeArticleForLang(doc, target, { fallbackToBase: true });
      if (!mapped) {
        return res.status(404).json({
          message: 'Article not available in requested language',
          requestedLang: target,
          availableLocales: getAvailableArticleLocales(doc),
        });
      }

      return res.json({
        ...doc,
        title: mapped.title,
        summary: mapped.summary,
        content: mapped.content,
        slug: mapped.slug,
        language: mapped.lang,
        requestedLang: mapped.requestedLang,
        resolvedLang: mapped.resolvedLang,
        isTranslated: mapped.isTranslated,
        canonicalSlug: mapped.canonicalSlug,
        availableLocales: getAvailableArticleLocales(doc),
      });
    }

    const canonicalSlug = (doc.slug || null);
    return res.json({
      ...doc,
      canonicalSlug,
      availableLocales: getAvailableArticleLocales(doc),
    });
  } catch (e) {
    return next(e);
  }
}

module.exports = { listArticles, getArticleBySlug };
