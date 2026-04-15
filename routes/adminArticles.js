const express = require('express');
const News = require('../models/News');
const mongoose = require('mongoose');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { enqueueTranslateAndSave } = require('../services/publishAsyncTranslation.service');
const { buildTranslationGroupStatus, resolveBaseLang } = require('../services/translationGroupStatus');
const { adminListReporterContacts } = require('../controllers/communityReporterController');

const router = express.Router();

function normalizeLangParam(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function normalizeRetryLang(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi') return s;
  if (s === 'all') return 'all';
  return null;
}

// Helper: build Mongo filter from query params
function buildFilter(query) {
  const {
    status,
    category,
    language,
    source,
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
  if (source && source !== 'all') {
    filter.source = String(source).trim();
  }
  // createdAt range filters per requirement
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (fromDate && !isNaN(fromDate)) {
    filter.createdAt = filter.createdAt || {};
    filter.createdAt.$gte = fromDate;
  }
  if (toDate && !isNaN(toDate)) {
    filter.createdAt = filter.createdAt || {};
    filter.createdAt.$lte = toDate;
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
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        ok: false,
        success: false,
        message: 'DB unavailable',
        path: req.originalUrl,
      });
    }

    const pageRaw = parseInt(String(req.query.page ?? '1'), 10);
    const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;
    const limitRaw = parseInt(String((req.query.pageSize ?? req.query.limit) ?? '20'), 10);
    const pageSize = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
    const skip = (page - 1) * pageSize;

    const filter = buildFilter(req.query);

    const allowedSortFields = new Set(['updatedAt', 'createdAt', 'publishedAt']);
    const sortRaw = String(req.query.sort || '-updatedAt');
    const sort = {};
    for (const partRaw of sortRaw.split(',')) {
      const part = String(partRaw || '').trim();
      if (!part) continue;
      const desc = part.startsWith('-');
      const field = desc ? part.slice(1) : part;
      if (!allowedSortFields.has(field)) continue;
      sort[field] = desc ? -1 : 1;
    }
    if (!Object.keys(sort).length) sort.updatedAt = -1;

    const [items, total] = await Promise.all([
      News.find(filter).sort(sort).skip(skip).limit(pageSize).lean(),
      News.countDocuments(filter),
    ]);

    return res.json({ ok: true, success: true, items, total, page, pageSize });
  } catch (e) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    console.error('[ADMIN_ARTICLES][list-error]', {
      method: req.method,
      url: req.originalUrl,
      message: e?.message || String(e),
      name: e?.name,
      stack: isProd ? undefined : e?.stack,
      query: req.query,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      message: 'Internal error',
      path: req.originalUrl,
      ...(isProd ? {} : { error: e?.message || String(e) }),
    });
  }
});

// GET /api/admin/articles/:id/translation-status
router.get('/articles/:id/translation-status', requireAdminAuth, async (req, res) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, success: false, message: 'DB unavailable' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }

    const doc = await News.findById(id)
      .select('title slug lang language originalLang translationStatus translationError translationUpdatedAt translationNextRetryAt translationKey translationGroupId spotlightEnabled spotlightPinned spotlightPriority spotlightExpiresAt')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });

    const groupKey = String(doc.translationKey || doc.translationGroupId || '').trim();
    const groupDocs = groupKey
      ? await News.find({ $or: [{ translationKey: groupKey }, { translationGroupId: groupKey }] })
        .select('_id lang language originalLang translationKey translationGroupId title slug status')
        .lean()
      : [doc];

    const groupStatus = buildTranslationGroupStatus(doc, groupDocs);

    const out = {
      id: String(doc._id),
      slug: doc.slug || null,
      title: doc.title || null,
      baseLang: groupStatus.baseLang,
      translationGroupKey: groupKey || null,
      languageStates: groupStatus,
      perLang: {},
    };

    for (const l of ['en', 'hi', 'gu']) {
      out.perLang[l] = {
        status: doc?.translationStatus?.[l] ?? null,
        error: doc?.translationError?.[l] ?? null,
        updatedAt: doc?.translationUpdatedAt?.[l] ?? null,
        nextRetryAt: doc?.translationNextRetryAt?.[l] ?? null,
        present: groupStatus.perLang[l].present,
        presence: groupStatus.perLang[l].presence,
        isSource: groupStatus.perLang[l].isSource,
        isTranslatedChild: groupStatus.perLang[l].isTranslatedChild,
        sourceArticleId: groupStatus.perLang[l].sourceArticleId,
        childArticleId: groupStatus.perLang[l].childArticleId,
        articleId: groupStatus.perLang[l].articleId,
      };
    }

    return res.json({ ok: true, success: true, data: out });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][translation-status-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Internal error' });
  }
});

// POST /api/admin/articles/:id/retry-translation?lang=hi|en|all
router.post('/articles/:id/retry-translation', requireAdminAuth, async (req, res) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, success: false, message: 'DB unavailable' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }

    const langParam = normalizeRetryLang(req.query.lang);
    if (!langParam) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing/invalid lang (use hi, en, or all)' });
    }

    const before = await News.findById(id)
      .select('lang language originalLang translationStatus translationError translationUpdatedAt translationNextRetryAt spotlightEnabled spotlightPinned spotlightPriority spotlightExpiresAt')
      .lean();
    if (!before) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });

    const baseLang = normalizeLangParam(before.originalLang) || normalizeLangParam(before.lang) || normalizeLangParam(before.language) || 'en';
    const targets = langParam === 'all' ? ['en', 'hi'] : [langParam];
    const now = new Date();

    const set = {};
    // Always keep base language as ready.
    set[`translationStatus.${baseLang}`] = 'ready';
    set[`translationError.${baseLang}`] = null;
    set[`translationNextRetryAt.${baseLang}`] = null;
    set[`translationUpdatedAt.${baseLang}`] = now;

    for (const t of targets) {
      if (t === baseLang) continue;
      set[`translationStatus.${t}`] = 'pending';
      set[`translationError.${t}`] = null;
      set[`translationNextRetryAt.${t}`] = null;
      set[`translationUpdatedAt.${t}`] = now;
    }

    const doc = await News.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: false }).lean();
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });

    enqueueTranslateAndSave(id, { logger: console });

    return res.json({ ok: true, success: true, message: 'Translation retry queued', data: { id, baseLang, targets } });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][retry-translation-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Internal error' });
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
      coverImageUrl,
      spotlightEnabled,
      spotlightPinned,
      spotlightPriority,
      spotlightExpiresAt,
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

    const resolvedCoverImageUrl = coverImageUrl ?? imageURL;
    const article = new News({
      title,
      description: description ?? summary ?? '',
      content,
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      category,
      status: status || 'draft',
      language: language || 'en',
      scheduledAt,
      imageURL: imageURL ?? resolvedCoverImageUrl,
      coverImageUrl: resolvedCoverImageUrl,
      ...(spotlightEnabled !== undefined ? { spotlightEnabled: Boolean(spotlightEnabled) } : {}),
      ...(spotlightPinned !== undefined ? { spotlightPinned: Boolean(spotlightPinned) } : {}),
      ...(spotlightPriority !== undefined ? { spotlightPriority: Number.isFinite(Number(spotlightPriority)) ? Number(spotlightPriority) : 0 } : {}),
      ...(spotlightExpiresAt !== undefined ? { spotlightExpiresAt: spotlightExpiresAt ? new Date(spotlightExpiresAt) : null } : {}),
    });

    await article.save();

    return res.status(201).json({ ok: true, success: true, article });
  } catch (e) {
    const message = e?.message || 'Failed to create article';
    console.error('[ADMIN_ARTICLES][create-error]', message);
    return res.status(400).json({ ok: false, success: false, message });
  }
});

// NOTE (final admin base): Mounted at /api/admin in server.js
// GET /api/admin/community/reporter-contacts
router.get('/community/reporter-contacts', requireAdminAuth, adminListReporterContacts);

module.exports = router;

// GET /api/admin/articles/:id -> returns article details, and if source=community with link, also includes communityReport
router.get('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ ok: false, message: 'Invalid article id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ ok: false, message: 'Invalid article id' });
    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: 'Article not found' });
    const article = doc.toJSON(); // include virtuals (e.g. body)

    const baseLang = resolveBaseLang(article);
    const groupKey = String(article.translationKey || article.translationGroupId || '').trim();
    const groupDocs = groupKey
      ? await News.find({ $or: [{ translationKey: groupKey }, { translationGroupId: groupKey }] })
        .select('_id lang language originalLang translationKey translationGroupId title slug status')
        .lean()
      : [article];
    const translationGroupStatus = buildTranslationGroupStatus({ ...article, originalLang: article.originalLang || baseLang }, groupDocs);

    let communityReport = null;
    if (article.source === 'community' && article.communityReportId) {
      try {
        const CommunitySubmission = require('../models/CommunitySubmission');
        communityReport = await CommunitySubmission.findById(article.communityReportId).lean();
      } catch (_) {}
    }

    try {
      console.log('[ADMIN][ARTICLE_EDIT] Returning article', {
        id: article._id?.toString?.() || article._id,
        hasBody: !!article.body,
        hasContent: !!article.content,
        language: article.language,
        source: article.source,
      });
    } catch (_) {}

    return res.json({
      ok: true,
      success: true,
      article,
      communityReport,
      translationGroupStatus,
    });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][detail-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load article details' });
  }
});

// PUT /api/admin/articles/:id -> update article
router.put('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });

    const body = req.body || {};
    const allowedStatuses = new Set(['draft','scheduled','published','archived','deleted']);

    const update = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.description !== undefined || body.summary !== undefined) update.description = body.description ?? body.summary ?? '';
    if (body.content !== undefined || body.body !== undefined) update.content = body.content ?? body.body ?? '';
    if (body.category !== undefined) update.category = body.category;
    if (body.language !== undefined) update.language = body.language || 'en';
    if (body.tags !== undefined) {
      const tags = Array.isArray(body.tags) ? body.tags : (body.tags ? String(body.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
      update.tags = tags;
    }
    if (body.status !== undefined) update.status = allowedStatuses.has(body.status) ? body.status : 'draft';
    if (body.scheduledAt !== undefined) {
      const dt = new Date(body.scheduledAt);
      update.scheduledAt = isNaN(dt) ? undefined : dt;
    }
    if (body.publishAt !== undefined) {
      const dt = new Date(body.publishAt);
      update.publishAt = isNaN(dt) ? undefined : dt;
    }
    if (body.slug !== undefined) update.slug = body.slug;
    if (body.spotlightEnabled !== undefined) update.spotlightEnabled = Boolean(body.spotlightEnabled);
    if (body.spotlightPinned !== undefined) update.spotlightPinned = Boolean(body.spotlightPinned);
    if (body.spotlightPriority !== undefined) {
      const parsedPriority = Number(body.spotlightPriority);
      update.spotlightPriority = Number.isFinite(parsedPriority) ? parsedPriority : 0;
    }
    if (body.spotlightExpiresAt !== undefined) {
      update.spotlightExpiresAt = body.spotlightExpiresAt ? new Date(body.spotlightExpiresAt) : null;
    }

    const resolvedCoverImageUrl = body.coverImageUrl ?? body.imageURL;
    if (resolvedCoverImageUrl !== undefined) update.coverImageUrl = resolvedCoverImageUrl;
    if (body.imageURL !== undefined) update.imageURL = body.imageURL;
    else if (resolvedCoverImageUrl !== undefined) update.imageURL = resolvedCoverImageUrl;

    const doc = await News.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.json({ ok: true, success: true, article: doc });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][update-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update article' });
  }
});

// PATCH /api/admin/articles/:id -> partial update (alias to PUT logic)
router.patch('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });

    const body = req.body || {};
    const allowedStatuses = new Set(['draft','scheduled','published','archived','deleted']);

    const update = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.description !== undefined || body.summary !== undefined) update.description = body.description ?? body.summary ?? '';
    if (body.content !== undefined || body.body !== undefined) update.content = body.content ?? body.body ?? '';
    if (body.category !== undefined) update.category = body.category;
    if (body.language !== undefined) update.language = body.language || 'en';
    if (body.tags !== undefined) {
      const tags = Array.isArray(body.tags) ? body.tags : (body.tags ? String(body.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
      update.tags = tags;
    }
    if (body.status !== undefined) update.status = allowedStatuses.has(body.status) ? body.status : 'draft';
    if (body.scheduledAt !== undefined) {
      const dt = new Date(body.scheduledAt);
      update.scheduledAt = isNaN(dt) ? undefined : dt;
    }
    if (body.publishAt !== undefined) {
      const dt = new Date(body.publishAt);
      update.publishAt = isNaN(dt) ? undefined : dt;
    }
    if (body.slug !== undefined) update.slug = body.slug;

    const resolvedCoverImageUrl = body.coverImageUrl ?? body.imageURL;
    if (resolvedCoverImageUrl !== undefined) update.coverImageUrl = resolvedCoverImageUrl;
    if (body.imageURL !== undefined) update.imageURL = body.imageURL;
    else if (resolvedCoverImageUrl !== undefined) update.imageURL = resolvedCoverImageUrl;

    const doc = await News.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.json({ ok: true, success: true, article: doc });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][patch-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update article' });
  }
});

// DELETE /api/admin/articles/:id -> soft delete by default; supports hard delete via query param
router.delete('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const hard = String(req.query.hard || '').toLowerCase() === 'true' || req.query.hard === true || req.query.hard === 1 || req.query.hard === '1';

    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id || '');
    if (!isObjectIdLike) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });
    }

    if (hard) {
      const doc = await News.findByIdAndDelete(id);
      if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
      return res.status(200).json({ ok: true, success: true });
    }

    const doc = await News.findByIdAndUpdate(id, { $set: { status: 'deleted' } }, { new: true });
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.status(200).json({ ok: true, success: true, article: doc });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][delete-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to delete article' });
  }
});

// DELETE /api/admin/articles/:id/hard -> always hard delete
router.delete('/articles/:id/hard', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id || '');
    if (!isObjectIdLike) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });
    }
    const doc = await News.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.status(200).json({ ok: true, success: true });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][delete-hard-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to hard delete article' });
  }
});

// DELETE /api/admin/articles/:id/hard-delete -> alias for hard delete for compatibility
router.delete('/articles/:id/hard-delete', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id || '');
    if (!isObjectIdLike) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid article id' });
    }
    const doc = await News.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.status(200).json({ ok: true, success: true });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][delete-hard-alias-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to hard delete article' });
  }
});
