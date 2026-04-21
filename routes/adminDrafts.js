const express = require('express');
const mongoose = require('mongoose');
const News = require('../models/News');
let { requireAdminAuth } = (() => { try { return require('../middleware/adminAuth'); } catch (_) { return { requireAdminAuth: (_req,_res,next)=>next() }; } })();

const router = express.Router();

// GET /api/admin/drafts
// Supports filters: ?deleted=1 (only deleted), ?deleted=0 (exclude deleted), default exclude deleted
// Optional: ?source=community|editor|pro|founder
router.get('/drafts', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;
    const deleted = req.query.deleted;
    const source = (req.query.source || '').toString().trim();

    const query = {};
    if (deleted === '1' || deleted === 1) {
      query.status = 'deleted';
    } else if (deleted === '0' || deleted === 0 || deleted === undefined) {
      query.status = 'draft';
    }
    if (source) query.source = source;

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
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load drafts' });
  }
});

// POST /api/admin/drafts/:id/delete → soft delete draft (status: 'deleted')
router.post('/drafts/:id/delete', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }
    const doc = await News.findById(id);
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, message: 'Draft not found' });
    }
    doc.status = 'deleted';
    if ('deletedAt' in doc) doc.deletedAt = new Date();
    await doc.save();
    return res.json({ ok: true, success: true, data: doc });
  } catch (err) {
    console.error('[ADMIN_DRAFTS][delete-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to delete draft' });
  }
});

// POST /api/admin/drafts/:id/restore → restore draft (status: 'draft')
router.post('/drafts/:id/restore', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }
    const doc = await News.findById(id);
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, message: 'Draft not found' });
    }
    doc.status = 'draft';
    if ('deletedAt' in doc) doc.deletedAt = null;
    await doc.save();
    return res.json({ ok: true, success: true, data: doc });
  } catch (err) {
    console.error('[ADMIN_DRAFTS][restore-error]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to restore draft' });
  }
});

module.exports = router;