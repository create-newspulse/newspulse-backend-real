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
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * pageSize;

    const filter = buildFilter(req.query);

    const sortRaw = (req.query.sort || '-createdAt').toString();
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
    const message = e?.message || 'Failed to create article';
    console.error('[ADMIN_ARTICLES][create-error]', message);
    return res.status(400).json({ ok: false, success: false, message });
  }
});

// NOTE (final admin base): Mounted at /api/admin in server.js
// GET /api/admin/community/reporter-contacts
router.get('/community/reporter-contacts', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const CommunitySubmission = require('../models/CommunitySubmission');

    const pipeline = [
      {
        $addFields: {
          groupEmail: { $ifNull: ['$reporterEmail', '$email'] },
          groupPhone: '$contact.phone',
          groupName: { $ifNull: ['$reporterName', '$userName'] },
          locCity: { $ifNull: ['$city', '$locationDetail.city'] },
          locState: { $ifNull: ['$state', '$locationDetail.state'] },
          locCountry: { $ifNull: ['$country', '$locationDetail.country'] },
          statusNorm: { $toUpper: { $ifNull: ['$status', ''] } },
        },
      },
      {
        $addFields: {
          groupId: { $ifNull: ['$groupEmail', { $ifNull: ['$groupPhone', { $toString: '$_id' }] }] },
        },
      },
      { $match: { groupId: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$groupId',
          id: { $first: '$groupId' },
          name: { $last: '$groupName' },
          email: { $last: '$groupEmail' },
          phone: { $last: '$groupPhone' },
          city: { $last: '$locCity' },
          state: { $last: '$locState' },
          country: { $last: '$locCountry' },
          totalStories: { $sum: 1 },
          pendingStories: { $sum: { $cond: [ { $or: [
            { $eq: ['$statusNorm', 'PENDING'] },
            { $eq: ['$statusNorm', 'UNDER_REVIEW'] },
            { $eq: ['$statusNorm', 'NEW'] },
            { $eq: ['$statusNorm', 'AI_REVIEWED'] },
            { $eq: ['$statusNorm', 'PENDING_FOUNDER'] },
          ] }, 1, 0 ] } },
          approvedStories: { $sum: { $cond: [ { $or: [
            { $eq: ['$statusNorm', 'APPROVED'] },
            { $eq: ['$statusNorm', 'PUBLISHED'] },
          ] }, 1, 0 ] } },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
      { $sort: { lastStoryAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const [items, countAgg] = await Promise.all([
      CommunitySubmission.aggregate(pipeline),
      CommunitySubmission.aggregate([
        { $addFields: { groupEmail: { $ifNull: ['$reporterEmail', '$email'] }, groupPhone: '$contact.phone' } },
        { $addFields: { groupId: { $ifNull: ['$groupEmail', { $ifNull: ['$groupPhone', { $toString: '$_id' }] }] } } },
        { $match: { groupId: { $exists: true, $ne: '' } } },
        { $group: { _id: '$groupId' } },
        { $count: 'count' },
      ]),
    ]);

    const total = countAgg[0]?.count || 0;

    return res.json({
      ok: true,
      items: items.map(i => ({
        id: i.id,
        name: i.name || null,
        email: i.email || null,
        phone: i.phone || null,
        city: i.city || null,
        state: i.state || null,
        country: i.country || null,
        totalStories: i.totalStories || 0,
        pendingStories: i.pendingStories || 0,
        approvedStories: i.approvedStories || 0,
        lastStoryAt: i.lastStoryAt || null,
      })),
      total,
      page,
      limit,
    });
  } catch (e) {
    console.error('[ADMIN_CONTACTS][error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter contacts' });
  }
});

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

    return res.json({ ok: true, success: true, article, communityReport });
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
    if (body.imageURL !== undefined) update.imageURL = body.imageURL;

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
    if (body.imageURL !== undefined) update.imageURL = body.imageURL;

    const doc = await News.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });
    return res.json({ ok: true, success: true, article: doc });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][patch-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update article' });
  }
});
