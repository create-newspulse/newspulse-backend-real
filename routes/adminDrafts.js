const express = require('express');
const mongoose = require('mongoose');
const News = require('../models/News');
const { changeArticleGroupStatus, restoreArticleGroup, articleMutationMetadata } = require('../services/articleLifecycle.service');
const { isContentDatabaseUnavailable } = require('../lib/contentErrors');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// GET /api/admin/drafts
// Supports filters: ?deleted=1 (only deleted), ?deleted=0 (exclude deleted), default exclude deleted
// Optional: ?source=community|editor|pro|founder
router.get('/drafts', requireAdminAuth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, success: false, code: 'ARTICLES_UNAVAILABLE', message: 'Database unavailable' });
    }
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;
    const deleted = req.query.deleted;
    const source = (req.query.source || '').toString().trim();
    const category = (req.query.category || '').toString().trim().toLowerCase();

    const query = {};
    if (deleted === '1' || deleted === 1) {
      query.status = 'deleted';
    } else if (deleted === '0' || deleted === 0 || deleted === undefined) {
      query.status = 'draft';
    }
    if (source) query.source = source;
    if (category && category !== 'all') query.category = category;

    const [items, total] = await Promise.all([
      News.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    const data = items.map(i => ({
      _id: i._id,
      articleId: i._id,
      headline: i.title,
      language: i.language,
      category: i.category,
      editorialType: i.category === 'editorial' ? (i.editorialType || 'editorial') : i.editorialType,
      createdAt: i.createdAt,
      status: i.status,
      source: i.source || null,
      sourceType: i.sourceType || null,
      sourceLabel: i.sourceLabel || null,
      submissionSource: i.submissionSource || null,
      sourceTrack: i.sourceTrack || null,
      location: [i.location?.city, i.location?.state].filter(Boolean).join(', ') || null,
      locationCity: i.location?.city || null,
      locationState: i.location?.state || null,
      draftType: i.source || 'editor',
      submissionId: i.communityReportId || null,
      youthPulseSubmissionId: i.youthPulseSubmissionId || null,
    }));

    return res.json({ ok: true, success: true, data, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_DRAFTS][list-error]', err?.message || err);
    return res.status(isContentDatabaseUnavailable(err) ? 503 : 500).json({ ok: false, success: false, message: 'Failed to load drafts' });
  }
});

// POST /api/admin/drafts/:id/delete → soft delete draft (status: 'deleted')
router.post('/drafts/:id/delete', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }
    const result = await changeArticleGroupStatus(id, 'deleted', { req });
    const doc = result.doc;
    return res.json({ ok: true, success: true, data: doc, deletedCount: result.changedCount, deletedIds: result.changedIds, ...articleMutationMetadata(result) });
  } catch (err) {
    console.error('[ADMIN_DRAFTS][delete-error]', err?.message || err);
    return res.status(err.statusCode || err.status || 503).json({ ok: false, success: false, message: err.status ? err.message : 'Failed to delete story' });
  }
});

// POST /api/admin/drafts/:id/restore restores the logical story's pre-delete statuses.
router.post('/drafts/:id/restore', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }
    const result = await restoreArticleGroup(id, { req });
    const doc = result.doc;
    return res.json({
      ok: true, success: true, data: doc, changedCount: result.changedCount, changedIds: result.changedIds,
      restoredStatuses: [...new Set(result.docs.map(member => member.status))], restoreFallbackIds: result.restoreFallbackIds,
      ...articleMutationMetadata(result),
    });
  } catch (err) {
    console.error('[ADMIN_DRAFTS][restore-error]', err?.message || err);
    const status = Number(err?.statusCode || err?.status) || 503;
    return res.status(status).json({ ok: false, success: false, message: status === 500 ? 'Failed to restore draft' : err.message });
  }
});

module.exports = router;