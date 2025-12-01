const express = require('express');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const { createDraftArticleFromSubmission } = require('../services/communityDraftFromSubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// GET /api/community/admin/community/queue
router.get('/queue', requireAdminAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const skip = (page - 1) * limit;

    const filter = {};
    // Optional status filter
    const status = (req.query.status || '').toString().trim().toUpperCase();
    if (status && status !== 'ALL') {
      if (status === 'PENDING') filter.status = { $in: ['NEW', 'AI_REVIEWED', 'PENDING_FOUNDER'] };
      else if (['NEW', 'APPROVED', 'REJECTED'].includes(status)) filter.status = status;
    }

    const [items, total] = await Promise.all([
      CommunitySubmission.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      ok: true,
      total,
      page,
      limit,
      items,
    });
  } catch (e) {
    console.error('[COMMUNITY_ADMIN][queue-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load queue' });
  }
});

// GET /api/community/admin/community/:id
router.get('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, item: doc });
  } catch (e) {
    console.error('[COMMUNITY_ADMIN][get-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

// POST /api/community/admin/community/:id/decision
// body: { action: 'APPROVE' | 'REJECT', rejectReasonCode?, rejectReasonNote? }
router.post('/:id/decision', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { action, rejectReasonCode, rejectReasonNote } = req.body || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const normalized = String(action || '').trim().toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(normalized)) {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    const doc = await CommunitySubmission.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    if (normalized === 'APPROVE') {
      doc.status = 'APPROVED';
      doc.rejectReason = undefined;
      doc.rejectReasonCode = undefined;
      doc.rejectReasonNote = undefined;
    } else if (normalized === 'REJECT') {
      doc.status = 'REJECTED';
      // Store codes/notes for traceability, keep legacy rejectReason for compatibility
      doc.rejectReasonCode = (rejectReasonCode || '').toString().trim() || undefined;
      doc.rejectReasonNote = (rejectReasonNote || '').toString().trim() || undefined;
      doc.rejectReason = doc.rejectReasonNote || 'Rejected';
    }
    doc.decisionBy = req.admin?.email || req.admin?.id || 'admin';

    await doc.save();

    // On approve, upsert/create a draft for Draft Desk
    let article = null;
    if (doc.status === 'APPROVED') {
      try {
        const result = await createDraftArticleFromSubmission(doc._id.toString());
        article = result.article || null;
      } catch (e) {
        console.error('[COMMUNITY_ADMIN][decision-approve-draft-error]', e?.message || e);
      }
    }

    return res.json({ success: true, ok: true, item: {
      id: doc._id.toString(),
      status: doc.status,
      decisionBy: doc.decisionBy || null,
      rejectReasonCode: doc.rejectReasonCode || null,
      rejectReasonNote: doc.rejectReasonNote || null,
      updatedAt: doc.updatedAt,
      draftArticleId: article ? article._id.toString() : (doc.linkedArticleId ? doc.linkedArticleId.toString() : null),
    }});
  } catch (e) {
    console.error('[COMMUNITY_ADMIN][decision-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to update decision' });
  }
});

module.exports = router;
