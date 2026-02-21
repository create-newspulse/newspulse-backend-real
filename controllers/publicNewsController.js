const mongoose = require('mongoose');

const News = require('../models/News');
const { safeTranslateText, normalizeLang } = require('../services/translate/safeTranslate');
const { translateText } = require('../services/translate/googleTranslateHelper');
const { getSlugCandidates, safeDecodeURIComponent, canonicalizeSlug } = require('../lib/slug');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isDbReadyOrTest() {
  return (mongoose.connection && mongoose.connection.readyState === 1) || String(process.env.NODE_ENV || '').toLowerCase() === 'test';
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

function normalizeTopicSlug(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? s : null;
}

function normalizeLocationPart(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
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
  return (
    normalizeLanguage(req.query.lang) ||
    normalizeLanguage(req.query.language) ||
    normalizeLanguage(req.headers['x-lang']) ||
    normalizeLanguage(req.headers['x-language']) ||
    normalizeLanguage(req.lang) ||
    null
  );
}

function applyLangFilter(filter, lang) {
  if (!lang) return;
  const lower = String(lang).trim().toLowerCase();
  const upper = lower.toUpperCase();
  if (lang === 'gu') {
    filter.$and.push({
      $or: [
        { lang: { $in: [lower, upper] } },
        { language: { $in: [lower, upper] } },
        // Default-to-gu ONLY when neither field provides a language.
        {
          $and: [
            { $or: [{ lang: null }, { lang: { $exists: false } }] },
            { $or: [{ language: null }, { language: { $exists: false } }] },
          ],
        },
      ],
    });
  } else {
    filter.$and.push({ $or: [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }] });
  }
}

function isPlainTextBody(content) {
  const s = String(content || '');
  if (!s.trim()) return true;
  return !/[<][^>]+[>]/.test(s);
}

async function translateNewsDocFields(doc, targetLang, { contextPrefix = 'news', strict = false } = {}) {
  const requested = normalizeLang(targetLang);
  if (!requested) return { doc, changed: false, flags: { bodyTranslated: false } };

  const source = normalizeLang(doc.lang || doc.language) || 'gu';
  if (source === requested) return { doc, changed: false, flags: { bodyTranslated: false } };

  let changed = false;
  const warnings = [];

  const titleRes = await safeTranslateText({
    text: doc.title || '',
    sourceLang: source,
    targetLang: requested,
    context: `${contextPrefix}:title`,
    strict,
  });
  if (!titleRes.usedFallback && titleRes.text) {
    doc.title = titleRes.text;
    changed = true;
  } else if (titleRes.warnings?.length) {
    warnings.push(...titleRes.warnings);
  }

  const descRes = await safeTranslateText({
    text: doc.description || doc.summary || '',
    sourceLang: source,
    targetLang: requested,
    context: `${contextPrefix}:summary`,
    strict,
  });
  if (!descRes.usedFallback && descRes.text) {
    doc.description = descRes.text;
    changed = true;
  } else if (descRes.warnings?.length) {
    warnings.push(...descRes.warnings);
  }

  let bodyTranslated = false;
  if (typeof doc.content === 'string' && doc.content.trim()) {
    if (isPlainTextBody(doc.content)) {
      const bodyRes = await safeTranslateText({
        text: doc.content,
        sourceLang: source,
        targetLang: requested,
        context: `${contextPrefix}:body`,
        strict: false,
      });
      if (!bodyRes.usedFallback && bodyRes.text) {
        doc.content = bodyRes.text;
        changed = true;
        bodyTranslated = true;
      } else {
        bodyTranslated = false;
        warnings.push('body_not_translated');
      }
    } else {
      // Safe behavior for rich text: do not translate body.
      bodyTranslated = false;
      warnings.push('body_richtext_not_translated');
    }
  }

  if (changed) {
    doc.lang = requested;
    doc.language = requested;
  }

  if (warnings.length) {
    doc.translation = {
      requestedLang: requested,
      sourceLang: source,
      bodyTranslated,
      warnings: Array.from(new Set(warnings)).slice(0, 8),
    };
  }

  return { doc, changed, flags: { bodyTranslated } };
}

// POST /api/public/news/:id/translate
// Stores translations in News.translations[lang] so switching is instant.
async function translatePublicNews(req, res) {
  try {
    const target = normalizeLanguage(req.body && req.body.lang);
    if (!target) return res.status(400).json({ success: false });

    if (!isDbReadyOrTest()) {
      return res.status(503).json({ success: false, message: 'Database unavailable' });
    }

    const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'Missing GOOGLE_TRANSLATE_API_KEY' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });

    const doc = await News.findById(id);
    if (!doc || String(doc.status || '').toLowerCase() !== 'published') {
      return res.status(404).json({ success: false });
    }

    if (doc.translations && doc.translations[target] && String(doc.translations[target].content || '').trim()) {
      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      return res.status(200).json({ success: true, data: { ...obj, activeLang: target } });
    }

    const sourceLang = normalizeLanguage(doc.lang || doc.language) || 'en';
    const title = String(doc.title || '');
    const summary = String(doc.summary || doc.description || '');
    const content = String(doc.content || doc.body || '');

    const [tTitle, tSummary, tContent] = await Promise.all([
      translateText(title, target, { apiKey }),
      translateText(summary, target, { apiKey }),
      translateText(content, target, { apiKey }),
    ]);

    doc.translations = doc.translations || {};
    doc.translations[target] = {
      title: tTitle && tTitle.ok ? tTitle.text : title,
      summary: tSummary && tSummary.ok ? tSummary.text : summary,
      content: tContent && tContent.ok ? tContent.text : content,
    };

    await doc.save();

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.status(200).json({ success: true, data: { ...obj, activeLang: target } });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'translate failed' });
  }
}

function buildPublicPublishedFilter({ category, q, founderOnly, type }) {
  const now = new Date();
  const normalizedCategory = category ? normalizeCategorySlug(category) : null;

  const filter = {
    $and: [
      // Public list must only include published stories.
      { status: { $regex: '^published$', $options: 'i' } },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: now } }] },
    ],
  };

  if (normalizedCategory) {
    // Case-safe for older mixed-case data.
    filter.category = new RegExp(`^${escapeRegExp(normalizedCategory)}$`, 'i');
  }

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
  'topic',
  'location',
  'lang',
  'language',
  'translationKey',
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
  out.lang = out.lang || out.language || 'gu';
  out.language = out.language || out.lang || 'gu';
  return out;
}

// GET /api/public/news?category=&type=video&founderOnly=true&limit=30&page=1
async function listPublicNews(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);

    const category = normalizeCategorySlug(req.query.category);
    const topic = normalizeTopicSlug(req.query.topic);
    const state = normalizeLocationPart(req.query.state || req.query.locationState);
    const founderOnly = parseTruthy(req.query.founderOnly);
    const type = String(req.query.type || '').trim().toLowerCase();

    // Default language for public story feed is Gujarati (backward compatible).
    const requestedLang = getRequestedLang(req) || 'gu';

    let q = String(req.query.q || '').trim();
    // Keep keyword search safe and bounded
    if (q.length > 80) q = q.slice(0, 80);

    if (!isDbReady()) {
      return res.status(200).json({ items: [], page, limit, total: 0, totalPages: 1 });
    }

    const buildFilterForLang = (lang) => {
      const f = buildPublicPublishedFilter({
        category: category || undefined,
        q: q || undefined,
        founderOnly,
        type,
      });
      if (topic) f.$and.push({ topic: new RegExp(`^${escapeRegExp(topic)}$`, 'i') });
      if (state) f.$and.push({ 'location.state': new RegExp(`^${escapeRegExp(state)}$`, 'i') });
      applyLangFilter(f, lang);
      return f;
    };

    const filter = buildFilterForLang(requestedLang);

    const skip = (page - 1) * limit;
    const sort = { publishedAt: -1, createdAt: -1 };

    let [itemsRaw, total] = await Promise.all([
      News.find(filter).select(PUBLIC_SELECT).sort(sort).skip(skip).limit(limit).lean(),
      News.countDocuments(filter),
    ]);

    // If the requested language has no docs, fall back to Gujarati and translate server-side.
    const shouldFallbackTranslate = total === 0 && requestedLang !== 'gu';
    if (shouldFallbackTranslate) {
      const fallbackFilter = buildFilterForLang('gu');
      [itemsRaw, total] = await Promise.all([
        News.find(fallbackFilter).select(PUBLIC_SELECT).sort(sort).skip(skip).limit(limit).lean(),
        News.countDocuments(fallbackFilter),
      ]);
    }

    let items = (itemsRaw || []).map(withCoverImageUrl);

    if (shouldFallbackTranslate && items.length) {
      items = await Promise.all(
        items.map(async (it) => {
          const out = { ...it };
          await translateNewsDocFields(out, requestedLang, { contextPrefix: 'news:list', strict: false });
          return out;
        })
      );
    }
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({ items, page, limit, total, totalPages });
  } catch (e) {
    return res.status(500).json({ items: [], page: 1, limit: 30, total: 0, totalPages: 1, message: e?.message || String(e) });
  }
}

// GET /api/public/news/translation?translationKey=...&lang=...
async function getPublicNewsByTranslationKey(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const translationKey = String(req.query.translationKey || '').trim();
    if (!translationKey) return res.status(400).json({ message: 'Missing translationKey' });

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    const requestedLang = getRequestedLang(req);
    const base = buildPublicPublishedFilter({});
    base.$and.push({ $or: [{ translationKey }, { translationGroupId: translationKey }] });

    const filter = { ...base, $and: [...(base.$and || [])] };
    if (requestedLang) applyLangFilter(filter, requestedLang);

    let doc = await News.findOne(filter).select(PUBLIC_SELECT).lean();
    if (!doc && !requestedLang) {
      // Default: try Gujarati if not specified.
      const fallback = { ...base, $and: [...(base.$and || [])] };
      applyLangFilter(fallback, 'gu');
      doc = await News.findOne(fallback).select(PUBLIC_SELECT).lean();
    }

    if (!doc) return res.status(404).json({ message: 'Not found' });

    const out = withCoverImageUrl(doc);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
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

    // Prefer requested language doc when available.
    const requestedLang = getRequestedLang(req);

    let lookup;
    if (isObjectIdLike(slugOrIdRaw)) {
      lookup = { _id: slugOrIdRaw };
    } else {
      const slugCandidates = getSlugCandidates(slugOrIdRaw);
      const slugFilter = slugCandidates.length === 1 ? slugCandidates[0] : { $in: slugCandidates };
      lookup = { slug: slugFilter };
    }

    if (requestedLang) {
      const byLangFilter = { ...base, ...lookup, $and: [...(base.$and || [])] };
      applyLangFilter(byLangFilter, requestedLang);
      doc = await News.findOne(byLangFilter).select(PUBLIC_SELECT).lean();
    }

    if (!doc) {
      doc = await News.findOne({ ...base, ...lookup }).select(PUBLIC_SELECT).lean();
    }

    if (!doc) {
      return res.status(404).json({ message: 'Not found' });
    }

    const out = withCoverImageUrl(doc);

    // If caller requested a different language, translate fields best-effort.
    const target = normalizeLang(requestedLang);
    if (target && target !== normalizeLang(out.lang || out.language)) {
      await translateNewsDocFields(out, target, { contextPrefix: 'news:detail', strict: true });
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

// GET /api/public/news/slug/:slug
// Unicode-safe: tries both decoded and raw slug variants.
async function getPublicNewsBySlug(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const decodedParam = String(req.params.slug ?? '').trim();
    if (!decodedParam) return res.status(400).json({ message: 'Missing slug' });

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    // Express usually decodes route params. To also try the raw percent-encoded
    // form (which may be stored by older clients), extract it from originalUrl.
    const originalUrl = String(req.originalUrl || req.url || '');
    const rawFromUrl = (() => {
      const m = originalUrl.match(/\/slug\/([^?]+)/);
      return m && m[1] ? String(m[1]).trim() : '';
    })();

    const decoded = String(safeDecodeURIComponent(decodedParam) ?? '').trim();
    const candidates = new Set();
    if (decoded) candidates.add(decoded);
    if (decodedParam) candidates.add(decodedParam);
    if (rawFromUrl) candidates.add(rawFromUrl);

    // Also try canonical/normalized forms for stable lookups.
    const canonRaw = canonicalizeSlug(rawFromUrl || decodedParam);
    if (canonRaw) candidates.add(canonRaw);
    const canonDecoded = decoded ? canonicalizeSlug(decoded) : '';
    if (canonDecoded) candidates.add(canonDecoded);

    for (const c of getSlugCandidates(rawFromUrl || decodedParam)) candidates.add(c);

    const slugCandidates = Array.from(candidates).filter(Boolean);
    const slugFilter = slugCandidates.length <= 1 ? (slugCandidates[0] || decodedParam) : { $in: slugCandidates };

    const base = buildPublicPublishedFilter({});
    const requestedLang = getRequestedLang(req);

    let doc = null;
    if (requestedLang) {
      const byLangFilter = { ...base, slug: slugFilter, $and: [...(base.$and || [])] };
      applyLangFilter(byLangFilter, requestedLang);
      doc = await News.findOne(byLangFilter).select(PUBLIC_SELECT).lean();
    }

    if (!doc) {
      doc = await News.findOne({ ...base, slug: slugFilter }).select(PUBLIC_SELECT).lean();
    }

    if (!doc) return res.status(404).json({ message: 'Not found' });

    const out = withCoverImageUrl(doc);

    const target = normalizeLang(requestedLang);
    if (target && target !== normalizeLang(out.lang || out.language)) {
      await translateNewsDocFields(out, target, { contextPrefix: 'news:detail', strict: true });
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

module.exports = {
  listPublicNews,
  listPublicNewsTranslations,
  getPublicNewsByTranslationKey,
  getPublicNewsBySlugOrId,
  getPublicNewsBySlug,
  translatePublicNews,
};
