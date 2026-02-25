const express = require('express');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
// CMS/admin "articles" are stored in the News collection in this codebase.
// Keep an alias named Article for routes that treat these as "Articles".
const Article = News;
const mongoose = require('mongoose');
const { requireAdminAuth } = require('../middleware/adminAuth');
const PushHistory = require('../models/PushHistory');
const { canonicalizeSlug, getSlugCandidates, slugifyUnicode } = require('../lib/slug');
const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');


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

function _parseIntOrDefault(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function _parseSafeSort(raw, allowedFields, fallbackField = 'updatedAt', fallbackDir = -1) {
  const out = {};
  const s = String(raw || '').trim();
  if (s) {
    for (const partRaw of s.split(',')) {
      const part = String(partRaw || '').trim();
      if (!part) continue;
      const desc = part.startsWith('-');
      const field = desc ? part.slice(1) : part;
      if (!allowedFields.has(field)) continue;
      out[field] = desc ? -1 : 1;
    }
  }

  if (!Object.keys(out).length) {
    out[fallbackField] = fallbackDir;
  }
  return out;
}

function normalizeSlug(slug) {
  return canonicalizeSlug(slug);
}

function slugifyFromTitle(title) {
  return slugifyUnicode(title);
}

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function getTitleForLangFromDocLike(docLike, lang) {
  const desired = normalizeLanguage(lang);
  if (!desired) return '';

  const t = docLike && docLike.translations && docLike.translations[desired];
  const fromTranslations = t && typeof t.title === 'string' ? t.title : '';
  if (fromTranslations && fromTranslations.trim()) return fromTranslations;

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || null;
  if (baseLang === desired) return String(docLike?.title || '');
  return '';
}

function ensureNewsSlugs(docLike) {
  if (!docLike) return;
  const out = { ...(docLike.slugs || {}) };
  for (const lang of ['en', 'hi', 'gu']) {
    const t = getTitleForLangFromDocLike(docLike, lang);
    if (t && t.trim()) out[lang] = slugifyUnicode(t);
  }

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
  if (!out[baseLang] && docLike.title) {
    out[baseLang] = slugifyUnicode(docLike.title);
  }

  docLike.slugs = out;
  if ((!docLike.slug || !String(docLike.slug).trim()) && out[baseLang]) {
    docLike.slug = out[baseLang];
  }
}

async function assertSlugUnique(slug, excludeId) {
  if (!slug) return;
  const candidates = getSlugCandidates(slug);
  const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
  const q = { slug: slugFilter };
  if (excludeId) q._id = { $ne: excludeId };
  const existing = await News.findOne(q).select('_id slug').lean();
  if (existing) {
    const err = new Error('Slug already exists');
    err.status = 409;
    throw err;
  }
}

function validatePublishable(doc) {
  const missing = [];
  if (!doc?.title) missing.push('title');
  if (!doc?.slug) missing.push('slug');
  if (!doc?.category) missing.push('category');
  if (!doc?.language) missing.push('language');
  if (!doc?.content) missing.push('content');
  return missing;
}

function withCoverImageUrl(obj) {
  if (!obj) return obj;
  const coverUrl =
    (obj.coverImage && typeof obj.coverImage === 'object' && !Array.isArray(obj.coverImage) ? obj.coverImage.url : null) ||
    (typeof obj.coverImage === 'string' ? obj.coverImage : null) ||
    obj.coverImageUrl ||
    obj.imageURL ||
    null;

  const coverImageObj = (() => {
    const v = obj.coverImage;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return {
        url: v.url ? String(v.url) : (coverUrl || null),
        publicId: v.publicId ? String(v.publicId) : null,
        alt: v.alt ? String(v.alt) : null,
      };
    }
    if (typeof v === 'string') return { url: v, publicId: null, alt: null };
    if (coverUrl) return { url: coverUrl, publicId: null, alt: null };
    return v; // leave undefined/null as-is
  })();

  return { ...obj, coverImageUrl: coverUrl, ...(coverImageObj ? { coverImage: coverImageObj } : {}) };
}

function mapStatusToWorkflowStage(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'published') return 'PUBLISHED';
  if (s === 'scheduled') return 'SCHEDULED';
  if (s === 'archived') return 'ARCHIVED';
  if (s === 'deleted') return 'REJECTED';
  return 'DRAFT';
}

function ensureTranslationGroupIdForDoc(doc) {
  if (!doc) return null;
  const existing = String(doc.translationGroupId || '').trim();
  if (existing) return existing;
  const id = new mongoose.Types.ObjectId().toString();
  doc.translationGroupId = id;
  return id;
}

function getActor(req) {
  const raw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
  const byRole = raw === 'founder' ? 'FOUNDER' : (raw === 'staff' ? 'STAFF' : (raw === 'legal' ? 'LEGAL' : 'EDITOR'));
  // Keep byUserId optional; admin IDs are not guaranteed to be ObjectId
  const byUserId = null;
  return { byRole, byUserId };
}

async function syncArticleFromNews(doc) {
  if (!doc) return null;
  const slug = normalizeSlug(doc.slug);
  if (!slug) return null;

  const isPublished = String(doc.status || '').toLowerCase() === 'published';
  const coverUrl =
    (doc.coverImage && typeof doc.coverImage === 'object' && !Array.isArray(doc.coverImage) ? doc.coverImage.url : null) ||
    doc.coverImageUrl ||
    doc.imageURL ||
    null;
  const coverImage = coverUrl
    ? {
        url: coverUrl,
        publicId: doc.coverImage && typeof doc.coverImage === 'object' ? (doc.coverImage.publicId || null) : null,
        alt: doc.coverImage && typeof doc.coverImage === 'object' ? (doc.coverImage.alt || null) : null,
      }
    : { url: null, publicId: null, alt: null };
  const update = {
    title: doc.title,
    slug,
    slugs: doc.slugs || null,
    summary: doc.description || null,
    content: doc.content || null,
    category: doc.category,
    language: doc.language || 'en',
    status: isPublished ? 'published' : 'draft',
    publishedAt: isPublished ? (doc.publishedAt || new Date()) : null,
    isBreaking: String(doc.category || '').toLowerCase() === 'breaking',
    coverImage,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
  };

  // Do not let this throw and break the CMS flow; log and move on.
  try {
    return await PublicArticle.findOneAndUpdate(
      { slug },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
  } catch (e) {
    console.warn('[articles.syncArticleFromNews] failed', { slug, message: e?.message || String(e) });
    return null;
  }
}

// POST /api/articles → create a new article (CMS/admin)
router.post('/articles', requireAdminAuth, async (req, res, next) => {
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
      coverImageUrl,
      coverImage,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ ok: false, success: false, message: 'Title is required' });
    }

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const allowedStatuses = new Set(['draft', 'scheduled', 'published', 'archived', 'deleted']);
    const initialStatus = status ? String(status).toLowerCase() : 'draft';
    if (status !== undefined && !allowedStatuses.has(initialStatus)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status' });
    }

    let resolvedSlug = normalizeSlug(slug);
    if (!resolvedSlug) resolvedSlug = slugifyFromTitle(title);
    if (!resolvedSlug) {
      return res.status(400).json({ ok: false, success: false, message: 'Slug is required (or title must be slugifiable)' });
    }

    // Ensure slug uniqueness; if auto-generated from title, try a few suffixes.
    if (!normalizeSlug(slug)) {
      let candidate = resolvedSlug;
      for (let i = 0; i < 20; i++) {
        try {
          await assertSlugUnique(candidate);
          resolvedSlug = candidate;
          break;
        } catch (e) {
          if (e?.status !== 409) throw e;
          candidate = `${resolvedSlug}-${i + 2}`;
        }
      }
      await assertSlugUnique(resolvedSlug);
    } else {
      await assertSlugUnique(resolvedSlug);
    }

    const coverObj = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
    const resolvedCoverImageUrl = coverImageUrl ?? imageURL ?? (coverObj ? coverObj.url : undefined);
    const absoluteCoverImageUrl = resolvedCoverImageUrl !== undefined ? absolutizeUploadsUrl(resolvedCoverImageUrl) : null;
    const workflowStage = mapStatusToWorkflowStage(initialStatus);
    const now = new Date();
    const actor = getActor(req);
    const translationGroupId = (req.body && req.body.translationGroupId) ? String(req.body.translationGroupId).trim() : '';

    const langNorm = normalizeLanguage(language) || 'en';
    const slugs = { ...(req.body && req.body.slugs && typeof req.body.slugs === 'object' ? req.body.slugs : {}) };
    slugs[langNorm] = resolvedSlug;
    // Best-effort for other languages if titles exist in `translations` payload.
    if (req.body && req.body.translations && typeof req.body.translations === 'object') {
      for (const k of ['en', 'hi', 'gu']) {
        const t = req.body.translations && req.body.translations[k];
        const titleForSlug = t && typeof t.title === 'string' ? t.title : '';
        if (titleForSlug && titleForSlug.trim()) {
          slugs[k] = slugifyUnicode(titleForSlug);
        }
      }
    }

    const doc = await News.create({
      title,
      description: summary ?? '',
      content: content ?? body ?? '',
      category,
      language: language || 'en',
      lang: language || 'en',
      translationGroupId: translationGroupId || new mongoose.Types.ObjectId().toString(),
      tags: parseTags(tags),
      status: initialStatus || 'draft',
      scheduledAt: scheduled,
      imageURL: imageURL ?? resolvedCoverImageUrl,
      coverImageUrl: absoluteCoverImageUrl ?? null,
      ...(coverObj || absoluteCoverImageUrl ? {
        coverImage: {
          url: coverObj && coverObj.url !== undefined ? absolutizeUploadsUrl(coverObj.url) : (absoluteCoverImageUrl ?? null),
          publicId: coverObj && coverObj.publicId !== undefined ? (coverObj.publicId || null) : null,
          alt: coverObj && coverObj.alt !== undefined ? (coverObj.alt || null) : null,
        },
      } : {}),
      slug: resolvedSlug,
      slugs,

      workflowStage,
      workflowUpdatedAt: now,
      workflowHistory: [{
        at: now,
        byUserId: actor.byUserId,
        byRole: actor.byRole,
        action: 'MOVE_STAGE',
        fromStage: null,
        toStage: workflowStage,
        note: 'Created',
      }],
    });

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;

    if (String(doc.status || '').toLowerCase() === 'published') {
      // Translation queue/review system removed.
    }

    return res.status(201).json({
      ok: true,
      success: true,
      status: 201,
      message: 'Article created',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (err) {
    if (err?.status === 409) {
      return res.status(409).json({ ok: false, success: false, message: err.message || 'Slug already exists' });
    }
    return next(err);
  }
});

// GET /api/articles → list articles (CMS/admin Manage News)
router.get('/articles', requireAdminAuth, async (req, res, next) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      const readyState = (mongoose.connection && typeof mongoose.connection.readyState === 'number')
        ? mongoose.connection.readyState
        : -1;
      return res.status(503).json({
        ok: false,
        success: false,
        message: 'DB unavailable',
        readyState,
        path: req.originalUrl,
      });
    }

    // Client may send page=0; clamp to >= 1
    const page = Math.max(_parseIntOrDefault(req.query.page, 1), 1);
    const limit = _clampInt(_parseIntOrDefault(req.query.limit, 20), 1, 100);

    // Only allow safe sort fields.
    // Support "-updatedAt" => { updatedAt: -1 }
    const allowedSortFields = new Set(['updatedAt', 'createdAt', 'publishedAt']);
    const sortParam = _parseSafeSort(req.query.sort, allowedSortFields, 'updatedAt', -1);
    const statusRaw = (req.query.status || '').toString();
    const languageRaw = (req.query.language || '').toString().trim();
    const categoryRaw = (req.query.category || '').toString().trim();
    const qRaw = (req.query.q || '').toString().trim();
    const fromRaw = (req.query.from || '').toString().trim();
    const toRaw = (req.query.to || '').toString().trim();
    const query = {};
    if (statusRaw) {
      const statuses = statusRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (statuses.length > 0) {
        // Include docs where status matches OR status is missing (legacy)
        query.$or = [
          { status: { $in: statuses } },
          { status: { $exists: false } },
        ];
      }
    }
    if (languageRaw) query.language = languageRaw;
    if (categoryRaw) query.category = categoryRaw;
    if (qRaw) {
      const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$and = (query.$and || []).concat([
        {
          $or: [
            { title: rx },
            { description: rx },
            { content: rx },
          ],
        },
      ]);
    }

    const fromDate = fromRaw ? new Date(fromRaw) : null;
    const toDate = toRaw ? new Date(toRaw) : null;
    if (fromDate && !isNaN(fromDate)) {
      query.createdAt = query.createdAt || {};
      query.createdAt.$gte = fromDate;
    }
    if (toDate && !isNaN(toDate)) {
      query.createdAt = query.createdAt || {};
      query.createdAt.$lte = toDate;
    }
    const skip = (page - 1) * limit;

    const [itemsRaw, total] = await Promise.all([
      News.find(query).sort(sortParam).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    const items = (itemsRaw || []).map(withCoverImageUrl);

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: { items, page, limit, total },

      // Backward-compatible fields used by older admin panel builds
      items,
      articles: items,
      total,
      page,
      limit,
      sort: sortParam,
    });
  } catch (err) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    console.error('[ADMIN_ARTICLES][list] failed', {
      method: req.method,
      url: req.originalUrl,
      message: err?.message || String(err),
      name: err?.name,
      // Avoid logging stack in prod logs only if you prefer; leaving it helps debug.
      stack: isProd ? undefined : err?.stack,
      query: req.query,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      message: 'Internal error',
      path: req.originalUrl,
      ...(isProd ? {} : { error: err?.message || String(err) }),
    });
  }
});

// GET /api/public/articles → public site listing (published only)
router.get('/public/articles', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const sortParam = (req.query.sort || '-publishedAt').toString();
    const status = String(req.query.status || 'published').toLowerCase();
    if (status !== 'published') {
      return res.status(400).json({ ok: false, success: false, message: 'Only status=published is allowed' });
    }

    const languageRaw = (req.query.language || '').toString().trim();
    const categoryRaw = (req.query.category || '').toString().trim();
    const qRaw = (req.query.q || '').toString().trim();

    const query = { status: 'published' };
    if (languageRaw) query.language = languageRaw;
    if (categoryRaw) query.category = categoryRaw;
    if (qRaw) {
      const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ title: rx }, { description: rx }, { content: rx }];
    }

    const skip = (page - 1) * limit;
    const [itemsRaw, total] = await Promise.all([
      News.find(query).sort(sortParam).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    const items = (itemsRaw || []).map(withCoverImageUrl);
    return res.status(200).json({ ok: true, success: true, status: 200, data: { items, page, limit, total } });
  } catch (err) {
    return next(err);
  }
});

// Backward-compatible aliases for admin panel builds calling /api/news*
router.get('/news', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
});
router.get('/news/list', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
});
router.get('/news/all', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
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
    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    const out = withCoverImageUrl(obj);
    // Compatibility: some admin frontends expect `data.article` (while others expect `article`).
    return res.json({ ok: true, success: true, status: 200, article: out, data: { article: out } });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/articles/:id → update existing article by id (CMS/admin)
router.put('/articles/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const requestBody = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

    const {
      title,
      slug,
      summary,
      content,
      body: bodyText,
      category,
      language,
      tags,
      status,
      scheduledAt,
      imageURL,
      coverImageUrl,
      coverImage,
    } = requestBody;

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const allowedStatuses = new Set(['draft', 'scheduled', 'published', 'archived', 'deleted']);
    if (status !== undefined && status !== null && String(status).trim() !== '' && !allowedStatuses.has(String(status).toLowerCase())) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status' });
    }

    let before = null;
    try {
      before = await News.findById(rawId).select('status translationGroupId lang language slugs coverImage coverImageUrl imageURL').lean();
    } catch (_) {
      // ignore
    }

    const effectiveLang = normalizeLanguage(language) || normalizeLanguage(before?.lang || before?.language) || 'en';

    // On update: if slug is provided, use it. Otherwise if title is updated, regenerate slug for that language.
    const resolvedSlug = slug !== undefined
      ? normalizeSlug(slug)
      : (title !== undefined ? slugifyFromTitle(title) : undefined);

    if (resolvedSlug !== undefined) {
      if (!resolvedSlug) {
        return res.status(400).json({ ok: false, success: false, message: 'Slug cannot be empty' });
      }
      await assertSlugUnique(resolvedSlug, rawId);
    }

    const resolvedCoverImageUrl = coverImageUrl ?? imageURL;

    const coverObj = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
    const prevCover = (() => {
      const v = before && before.coverImage;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      const u = before && (before.coverImageUrl || before.imageURL);
      return u ? { url: u, publicId: null, alt: null } : null;
    })();
    let nextCover = null;
    if (coverObj) {
      nextCover = {
        url: prevCover && prevCover.url ? String(prevCover.url) : null,
        publicId: prevCover && prevCover.publicId ? String(prevCover.publicId) : null,
        alt: prevCover && prevCover.alt ? String(prevCover.alt) : null,
      };
      if (coverObj.url !== undefined) nextCover.url = absolutizeUploadsUrl(coverObj.url);
      if (coverObj.publicId !== undefined) nextCover.publicId = coverObj.publicId ? String(coverObj.publicId) : null;
      if (coverObj.alt !== undefined) nextCover.alt = coverObj.alt ? String(coverObj.alt) : null;
    }

    const update = {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { description: summary } : {}),
      ...(content !== undefined || bodyText !== undefined ? { content: content ?? bodyText ?? '' } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(language !== undefined ? { language, lang: language } : {}),
      ...(tags !== undefined ? { tags: parseTags(tags) } : {}),
      ...(status !== undefined && status !== null && String(status).trim() !== '' ? { status: String(status).toLowerCase() } : {}),
      ...(scheduled !== undefined ? { scheduledAt: scheduled } : {}),
      ...(imageURL !== undefined ? { imageURL } : {}),
      ...(coverImageUrl !== undefined ? { coverImageUrl: absolutizeUploadsUrl(coverImageUrl) } : {}),
      ...(resolvedCoverImageUrl !== undefined && coverImageUrl === undefined ? { coverImageUrl: absolutizeUploadsUrl(resolvedCoverImageUrl) } : {}),
      ...(resolvedCoverImageUrl !== undefined && imageURL === undefined ? { imageURL: resolvedCoverImageUrl } : {}),
      ...(nextCover ? {
        coverImage: nextCover,
        ...(nextCover.url ? {
          // keep legacy fields in sync for older clients
          coverImageUrl: nextCover.url,
          ...(imageURL === undefined ? { imageURL: nextCover.url } : {}),
        } : {}),
      } : {}),
      ...(resolvedSlug !== undefined ? { slug: resolvedSlug, [`slugs.${effectiveLang}`]: resolvedSlug } : {}),
    };

    let doc = null;
    try {
      doc = await News.findByIdAndUpdate(rawId, update, { new: true, runValidators: true });
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      // Fallback: some admin builds operate on the public Article model instead of News.
      const allowedArticleStatuses = new Set(['draft', 'published']);
      const articleUpdate = {
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(content !== undefined || bodyText !== undefined ? { content: content ?? bodyText ?? '' } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(language !== undefined ? { language: normalizeLanguage(language) || undefined } : {}),
        ...(tags !== undefined ? { tags: parseTags(tags) } : {}),
        ...(status !== undefined && status !== null && String(status).trim() !== '' && allowedArticleStatuses.has(String(status).toLowerCase())
          ? { status: String(status).toLowerCase() }
          : {}),
        ...(resolvedSlug !== undefined ? { slug: resolvedSlug, [`slugs.${effectiveLang}`]: resolvedSlug } : {}),
      };

      // coverImage (preferred) + legacy coverImageUrl/imageURL -> coverImage.url
      const nextCoverForArticle = (() => {
        const coverObj2 = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
        const urlFromLegacy = resolvedCoverImageUrl !== undefined ? absolutizeUploadsUrl(resolvedCoverImageUrl) : null;

        if (!coverObj2 && urlFromLegacy === null) return null;

        const out = { url: null, publicId: null, alt: null };
        if (coverObj2) {
          if (coverObj2.url !== undefined) out.url = absolutizeUploadsUrl(coverObj2.url);
          if (coverObj2.publicId !== undefined) out.publicId = coverObj2.publicId ? String(coverObj2.publicId) : null;
          if (coverObj2.alt !== undefined) out.alt = coverObj2.alt ? String(coverObj2.alt) : null;
        }

        if (out.url === null && urlFromLegacy) out.url = urlFromLegacy;
        return out;
      })();

      if (nextCoverForArticle) {
        articleUpdate.coverImage = nextCoverForArticle;
      }

      // Strip undefined fields so we don't unset enums accidentally.
      for (const k of Object.keys(articleUpdate)) {
        if (articleUpdate[k] === undefined) delete articleUpdate[k];
      }

      let articleDoc = null;
      try {
        articleDoc = await PublicArticle.findByIdAndUpdate(rawId, articleUpdate, { new: true, runValidators: true });
      } catch (e) {
        // Duplicate slug unique index
        if (e && (e.code === 11000 || e.code === 11001)) {
          return res.status(409).json({ ok: false, success: false, message: 'Slug already exists' });
        }
        throw e;
      }

      if (!articleDoc) {
        return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
      }

      const obj2 = articleDoc.toObject ? articleDoc.toObject({ virtuals: true }) : articleDoc;
      return res.json({
        ok: true,
        success: true,
        status: 200,
        message: 'Article updated',
        data: { article: withCoverImageUrl(obj2) },
        article: withCoverImageUrl(obj2),
      });
    }

    // Ensure other language slugs are kept in sync when translations exist.
    ensureNewsSlugs(doc);
    await doc.save();
    // If status changed, keep workflow stage aligned (non-breaking)
    if (update.status) {
      const stage = mapStatusToWorkflowStage(update.status);
      if (doc.workflowStage !== stage) {
        const actor = getActor(req);
        const now = new Date();
        const prevStage = String(doc.workflowStage || 'DRAFT');
        doc.workflowStage = stage;
        doc.workflowUpdatedAt = now;
        doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
        doc.workflowHistory.push({
          at: now,
          byUserId: actor.byUserId,
          byRole: actor.byRole,
          action: 'MOVE_STAGE',
          fromStage: prevStage,
          toStage: stage,
          note: 'Status updated',
        });
        ensureNewsSlugs(doc);
        await doc.save();
      }
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;

    // If an editor published via status update, enqueue translations.
    try {
      const beforeStatus = String(before && before.status ? before.status : '').toLowerCase();
      const afterStatus = String(doc.status || '').toLowerCase();
      if (beforeStatus !== 'published' && afterStatus === 'published') {
        // Ensure group id exists for translations.
        ensureTranslationGroupIdForDoc(doc);
        doc.lang = doc.lang || doc.language;
        doc.language = doc.language || doc.lang;
        await doc.save();
        // Translation queue/review system removed.
      }
    } catch (_) {}

    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article updated',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (err) {
    try { console.error('ArticleUpdate error:', err); } catch (_) {}
    if (err?.status === 409) {
      return res.status(409).json({ ok: false, success: false, message: err.message || 'Slug already exists' });
    }
    return next(err);
  }
});

// POST /api/articles/:id/publish → publish now (Founder only)
router.post('/articles/:id/publish', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const missing = validatePublishable(doc);
    if (missing.length) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: `Missing required fields: ${missing.join(', ')}` });
    }
    await assertSlugUnique(normalizeSlug(doc.slug), id);

    const now = new Date();
    doc.status = 'published';
    doc.publishedAt = now;
    doc.publishAt = null;
    doc.scheduledAt = null;
    ensureTranslationGroupIdForDoc(doc);
    doc.lang = doc.lang || doc.language;
    doc.language = doc.language || doc.lang;

    ensureNewsSlugs(doc);

    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.workflowStage = 'PUBLISHED';
    doc.workflowUpdatedAt = now;
    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'PUBLISH',
      fromStage,
      toStage: 'PUBLISHED',
      note: null,
    });

    await doc.save();

    await syncArticleFromNews(doc);

    // Phase 2: enqueue translations on publish.
    // Translation queue/review system removed.

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'publish',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'publish', oldStatus: 'draft', newStatus: 'published', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article published',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (e) {
    if (e?.status === 409) return res.status(409).json({ ok: false, success: false, status: 409, message: e.message || 'Slug already exists' });
    console.error('[articles.publish] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to publish article' });
  }
});

// POST /api/articles/:id/unpublish → back to draft/archived (Founder only)
router.post('/articles/:id/unpublish', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const toStatus = String(req.body?.toStatus || 'draft').toLowerCase();
    if (!['draft', 'archived'].includes(toStatus)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid toStatus (use draft or archived)' });
    }

    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const now = new Date();
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = toStatus;
    doc.publishedAt = null;
    doc.publishAt = null;
    doc.scheduledAt = null;
    doc.workflowStage = toStatus === 'archived' ? 'ARCHIVED' : 'DRAFT';
    doc.workflowUpdatedAt = now;

    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'UNPUBLISH',
      fromStage,
      toStage: doc.workflowStage,
      note: null,
    });

    await doc.save();

    await syncArticleFromNews(doc);

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'unpublish',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'unpublish', oldStatus: 'published', newStatus: toStatus, oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({ ok: true, success: true, status: 200, message: 'Article unpublished', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    console.error('[articles.unpublish] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to unpublish article' });
  }
});

// POST /api/articles/:id/schedule → set scheduled publish time (Editor/Founder)
router.post('/articles/:id/schedule', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw === 'staff') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const scheduledAtRaw = req.body?.publishAt ?? req.body?.scheduledAt;
    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
    if (!scheduledAt || isNaN(scheduledAt)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'publishAt/scheduledAt is required and must be a valid datetime' });
    }

    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const missing = validatePublishable(doc);
    if (missing.length) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: `Missing required fields: ${missing.join(', ')}` });
    }
    await assertSlugUnique(normalizeSlug(doc.slug), id);

    const now = new Date();
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = 'scheduled';
    doc.scheduledAt = scheduledAt;
    doc.publishAt = scheduledAt;
    doc.publishedAt = null;
    doc.workflowStage = 'SCHEDULED';
    doc.workflowUpdatedAt = now;

    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'MOVE_STAGE',
      fromStage,
      toStage: 'SCHEDULED',
      note: `Scheduled for ${scheduledAt.toISOString()}`,
    });

    await doc.save();

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'schedule',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'schedule', oldStatus: 'draft', newStatus: 'scheduled', oldStage: fromStage, newStage: doc.workflowStage, publishAt: scheduledAt.toISOString() },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({ ok: true, success: true, status: 200, message: 'Article scheduled', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    if (e?.status === 409) return res.status(409).json({ ok: false, success: false, status: 409, message: e.message || 'Slug already exists' });
    console.error('[articles.schedule] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to schedule article' });
  }
});

// POST /api/articles/:id/archive → archive (Editor/Founder)
router.post('/articles/:id/archive', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw === 'staff') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const now = new Date();
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = 'archived';
    doc.workflowStage = 'ARCHIVED';
    doc.workflowUpdatedAt = now;

    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'MOVE_STAGE',
      fromStage,
      toStage: 'ARCHIVED',
      note: null,
    });

    await doc.save();

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'archive',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'archive', oldStatus: 'draft', newStatus: 'archived', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({ ok: true, success: true, status: 200, message: 'Article archived', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    console.error('[articles.archive] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to archive article' });
  }
});

// DELETE /api/articles/:id → soft delete (CMS/admin)
router.delete('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await News.findById(id);
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const now = new Date();
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = 'deleted';
    doc.deletedAt = now;
    doc.workflowStage = 'REJECTED';
    doc.workflowUpdatedAt = now;
    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'REJECT',
      fromStage,
      toStage: 'REJECTED',
      note: 'Deleted',
    });

    await doc.save();

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'delete',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'delete', oldStatus: 'draft', newStatus: 'deleted', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article deleted',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
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

// DELETE /api/admin/articles/:id/forever → permanent delete (admin only; only if already deleted)
// NOTE: This router is mounted at multiple base paths; we enforce admin auth at the route level.
router.delete('/articles/:id/forever', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await Article.findById(id);
    } catch (_) {
      // invalid ObjectId
    }

    if (!doc) return res.status(404).json({ success: false, message: 'Article not found' });
    if (String(doc.status || '') !== 'deleted') {
      return res.status(400).json({ success: false, message: 'Only deleted articles can be permanently removed.' });
    }

    await Article.deleteOne({ _id: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[articles.forever-delete] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/admin/articles/forever/bulk → bulk permanent delete (admin only; deletes only status='deleted')
router.post('/articles/forever/bulk', requireAdminAuth, async (req, res) => {
  try {
    const rawIds = req.body && req.body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ success: false, message: 'ids is required' });
    }

    const ids = rawIds
      .map((v) => String(v || '').trim())
      .filter(Boolean);

    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'ids is required' });
    }

    for (const id of ids) {
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'Invalid id in ids' });
      }
    }

    const result = await Article.deleteMany({
      _id: { $in: ids },
      status: 'deleted',
    });

    const deletedCount = Number(result && typeof result.deletedCount === 'number' ? result.deletedCount : 0);
    return res.status(200).json({ success: true, deletedCount });
  } catch (err) {
    console.error('[articles.forever-delete.bulk] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /api/admin/articles/forever/all-deleted → delete ALL soft-deleted articles (admin only)
router.delete('/articles/forever/all-deleted', requireAdminAuth, async (req, res) => {
  try {
    const result = await Article.deleteMany({ status: 'deleted' });
    const deletedCount = Number(result && typeof result.deletedCount === 'number' ? result.deletedCount : 0);
    return res.status(200).json({ success: true, deletedCount });
  } catch (err) {
    console.error('[articles.forever-delete.all-deleted] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
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

module.exports = router;
