const express = require('express');
const News = require('../models/News');
const Article = require('../models/Article');
const mongoose = require('mongoose');
const { requireAdminAuth } = require('../middleware/adminAuth');
const PushHistory = require('../models/PushHistory');

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
  const s = String(slug || '').trim().toLowerCase();
  return s;
}

function slugifyFromTitle(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function assertSlugUnique(slug, excludeId) {
  if (!slug) return;
  const q = { slug };
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
  return { ...obj, coverImageUrl: obj.coverImageUrl || obj.imageURL || null };
}

function mapStatusToWorkflowStage(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'published') return 'PUBLISHED';
  if (s === 'scheduled') return 'SCHEDULED';
  if (s === 'archived') return 'ARCHIVED';
  if (s === 'deleted') return 'REJECTED';
  return 'DRAFT';
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
  const coverImage = doc.coverImageUrl || doc.imageURL || null;
  const update = {
    title: doc.title,
    slug,
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
    return await Article.findOneAndUpdate(
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

    const resolvedCoverImageUrl = coverImageUrl ?? imageURL;
    const workflowStage = mapStatusToWorkflowStage(initialStatus);
    const now = new Date();
    const actor = getActor(req);
    const doc = await News.create({
      title,
      description: summary ?? '',
      content: content ?? body ?? '',
      category,
      language: language || 'en',
      tags: parseTags(tags),
      status: initialStatus || 'draft',
      scheduledAt: scheduled,
      imageURL: imageURL ?? resolvedCoverImageUrl,
      coverImageUrl: resolvedCoverImageUrl,
      slug: resolvedSlug,

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
      return res.status(503).json({
        ok: false,
        success: false,
        message: 'DB unavailable',
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
    return res.json({ ok: true, success: true, article: out });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/articles/:id → update existing article by id (CMS/admin)
router.put('/articles/:id', requireAdminAuth, async (req, res, next) => {
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
      coverImageUrl,
    } = req.body || {};

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const allowedStatuses = new Set(['draft', 'scheduled', 'published', 'archived', 'deleted']);
    if (status !== undefined && status !== null && String(status).trim() !== '' && !allowedStatuses.has(String(status).toLowerCase())) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status' });
    }

    const resolvedSlug = slug !== undefined ? normalizeSlug(slug) : undefined;
    if (resolvedSlug !== undefined) {
      if (!resolvedSlug) {
        return res.status(400).json({ ok: false, success: false, message: 'Slug cannot be empty' });
      }
      await assertSlugUnique(resolvedSlug, id);
    }

    const resolvedCoverImageUrl = coverImageUrl ?? imageURL;
    const update = {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { description: summary } : {}),
      ...(content !== undefined || body !== undefined ? { content: content ?? body ?? '' } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(tags !== undefined ? { tags: parseTags(tags) } : {}),
      ...(status !== undefined && status !== null && String(status).trim() !== '' ? { status: String(status).toLowerCase() } : {}),
      ...(scheduled !== undefined ? { scheduledAt: scheduled } : {}),
      ...(imageURL !== undefined ? { imageURL } : {}),
      ...(coverImageUrl !== undefined ? { coverImageUrl } : {}),
      ...(resolvedCoverImageUrl !== undefined && imageURL === undefined ? { imageURL: resolvedCoverImageUrl } : {}),
      ...(resolvedSlug !== undefined ? { slug: resolvedSlug } : {}),
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
        await doc.save();
      }
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article updated',
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
