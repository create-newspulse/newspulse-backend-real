const express = require('express');
const mongoose = require('mongoose');
const News = require('../../models/News');
const PushHistory = require('../../models/PushHistory');
const { withActiveArticleSource, serializeNewsArticle, articleMutationMetadata } = require('../../services/articleLifecycle.service');
const { syncTranslationGroupMetadata } = require('../../services/translationGroupSync.service');
const { invalidateArticleContent } = require('../../services/publicContentInvalidation.service');
const { requireAdminAuth, requireFounderAuth } = require('../../middleware/adminAuth');

const router = express.Router();

const STAGES = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
  'ARCHIVED',
  'REJECTED',
];

const BOARD_COLUMNS = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
];

function ok(res, message, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, message, data });
}

function bad(res, message, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, success: false, status, message, ...extra });
}

function getActor(req) {
  const raw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
  const byRole = raw === 'founder' ? 'FOUNDER' : (raw === 'staff' ? 'STAFF' : (raw === 'legal' ? 'LEGAL' : 'EDITOR'));
  let byUserId = null;
  try {
    if (req.admin && req.admin.id && mongoose.isValidObjectId(req.admin.id)) byUserId = new mongoose.Types.ObjectId(req.admin.id);
  } catch (_) {}
  return { byRole, byUserId };
}

async function updatePublicVisibility(doc, req, patch, action, note = null) {
  const now = new Date();
  const actor = getActor(req);
  const result = await withActiveArticleSource(doc._id, async (current, session) => {
    const stage = String(current.workflowStage || 'DRAFT');
    const edited = await News.findByIdAndUpdate(current._id, {
      $set: { ...patch, workflowUpdatedAt: now },
      $push: { workflowHistory: {
        at: now, byUserId: actor.byUserId, byRole: actor.byRole,
        action, fromStage: stage, toStage: stage, note: note ? String(note) : null,
      } },
    }, { new: true, runValidators: true, session });
    if (!edited) throw Object.assign(new Error('Article changed. Reload and retry.'), { statusCode: 409 });
    return syncTranslationGroupMetadata(edited, { previousDoc: current, now, session, invalidate: false });
  });
  result.revalidation = await invalidateArticleContent(result.docs, {
    previousDocs: result.previousDocs, reason: `workflow_${action.toLowerCase()}`, publicVisibilityRemoved: true,
  });
  result.doc = serializeNewsArticle(result.docs.find(member => String(member._id) === String(doc._id)));
  return result;
}

function canOverrideLocks(req) {
  const raw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : '';
  return raw === 'founder';
}

function canMoveToStage(req, toStage) {
  const raw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
  const role = raw === 'founder' ? 'FOUNDER' : (raw === 'staff' ? 'STAFF' : (raw === 'legal' ? 'LEGAL' : 'EDITOR'));

  if (role === 'STAFF') {
    return ['DRAFT', 'COPY_EDIT'].includes(toStage);
  }
  if (role === 'EDITOR' || role === 'LEGAL') {
    return ['DRAFT', 'COPY_EDIT', 'LEGAL_REVIEW', 'EDITOR_APPROVAL', 'REJECTED'].includes(toStage);
  }
  if (role === 'FOUNDER') {
    // Founder can move anywhere except publishing directly (must use publish endpoint)
    return ['DRAFT','COPY_EDIT','LEGAL_REVIEW','EDITOR_APPROVAL','FOUNDER_APPROVAL','REJECTED'].includes(toStage);
  }
  return false;
}

function isValidTransition(fromStage, toStage) {
  if (!fromStage || !toStage) return false;
  if (fromStage === toStage) return true;
  if (toStage === 'REJECTED') return true;
  const allowed = {
    DRAFT: ['COPY_EDIT'],
    COPY_EDIT: ['DRAFT', 'LEGAL_REVIEW'],
    LEGAL_REVIEW: ['COPY_EDIT', 'EDITOR_APPROVAL'],
    EDITOR_APPROVAL: ['LEGAL_REVIEW', 'FOUNDER_APPROVAL'],
    FOUNDER_APPROVAL: ['EDITOR_APPROVAL'],
    REJECTED: ['DRAFT'],
  };
  return (allowed[fromStage] || []).includes(toStage);
}

function withCover(obj) {
  if (!obj) return obj;
  return { ...obj, coverImageUrl: obj.coverImageUrl || obj.imageURL || null };
}

// GET /api/admin/workflow/board
router.get('/board', requireAdminAuth, async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim();
    const lang = String(req.query.lang || req.query.language || '').trim();
    const category = String(req.query.category || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);

    const filter = {
      workflowStage: { $in: BOARD_COLUMNS },
      status: { $ne: 'deleted' },
    };

    if (lang) filter.language = lang;
    if (category) filter.category = category;
    if (qRaw) {
      const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: rx }, { description: rx }, { content: rx }, { slug: rx }];
    }

    // Optional risk filter only if schema supports it
    const risk = String(req.query.risk || '').trim();
    if (risk && News.schema && typeof News.schema.path === 'function' && News.schema.path('risk')) {
      filter.risk = risk;
    }

    const docs = await News.find(filter)
      .sort({ workflowUpdatedAt: -1, updatedAt: -1 })
      .limit(limit)
      .lean();

    const columns = {};
    const counts = {};
    BOARD_COLUMNS.forEach(k => { columns[k] = []; counts[k] = 0; });

    (docs || []).forEach(d => {
      const stage = d.workflowStage || 'DRAFT';
      if (!columns[stage]) return;
      const card = {
        _id: d._id,
        title: d.title,
        slug: d.slug || null,
        status: d.status || 'draft',
        language: d.language || 'en',
        category: d.category || null,
        workflowStage: stage,
        workflowUpdatedAt: d.workflowUpdatedAt || d.updatedAt || d.createdAt || null,
        locked: !!d.locked,
        embargoUntil: d.embargoUntil || null,
        scheduledAt: d.scheduledAt || null,
        publishedAt: d.publishedAt || null,
        coverImageUrl: d.coverImageUrl || d.imageURL || null,
      };
      columns[stage].push(card);
      counts[stage] += 1;
    });

    return ok(res, 'Workflow board', { columns, counts });
  } catch (e) {
    console.error('[workflow.board] error', e?.message || e);
    return bad(res, 'Failed to load workflow board', 500);
  }
});

// GET /api/admin/workflow/:articleId
router.get('/:articleId([0-9a-fA-F]{24})', requireAdminAuth, async (req, res) => {
  try {
    const { articleId } = req.params;
    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);

    const article = await News.findById(articleId).lean();
    if (!article) return bad(res, 'Article not found', 404);

    const pushHistory = await PushHistory.find({ articleId }).sort({ at: -1 }).limit(50).lean();

    return ok(res, 'Workflow detail', {
      article: withCover(article),
      workflowHistory: article.workflowHistory || [],
      internalComments: article.internalComments || [],
      pushHistory: pushHistory || [],
    });
  } catch (e) {
    console.error('[workflow.detail] error', e?.message || e);
    return bad(res, 'Failed to load workflow detail', 500);
  }
});

// PATCH /api/admin/workflow/:articleId/move
router.patch('/:articleId([0-9a-fA-F]{24})/move', requireAdminAuth, async (req, res) => {
  try {
    const { articleId } = req.params;
    const { toStage, note } = req.body || {};

    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);
    const stage = String(toStage || '').trim();
    if (!STAGES.includes(stage)) return bad(res, 'Invalid toStage', 400);

    // Do not allow direct publish from move endpoint
    if (stage === 'PUBLISHED') return bad(res, 'Use publish endpoint to publish', 400);
    if (stage === 'SCHEDULED') return bad(res, 'Use schedule endpoint to schedule', 400);
    if (stage === 'ARCHIVED') return bad(res, 'Use archive endpoint to archive', 400);

    const doc = await News.findById(articleId);
    if (!doc) return bad(res, 'Article not found', 404);

    const fromStage = String(doc.workflowStage || 'DRAFT');

    // Locks + embargo blocks
    const now = new Date();
    if (doc.locked && !canOverrideLocks(req)) {
      return bad(res, 'Article is locked', 409);
    }
    if (doc.embargoUntil && new Date(doc.embargoUntil) > now && !canOverrideLocks(req)) {
      return bad(res, 'Article is embargoed until ' + new Date(doc.embargoUntil).toISOString(), 409);
    }

    if (!canMoveToStage(req, stage)) {
      return bad(res, 'Insufficient permissions for stage move', 403);
    }

    // STAFF may only move within DRAFT/COPY_EDIT (also must be currently within those)
    const actorRole = getActor(req).byRole;
    if (actorRole === 'STAFF' && !['DRAFT', 'COPY_EDIT'].includes(fromStage)) {
      return bad(res, 'STAFF can only move items in DRAFT/COPY_EDIT', 403);
    }

    if (!isValidTransition(fromStage, stage)) {
      return bad(res, `Invalid stage transition: ${fromStage} -> ${stage}`, 400);
    }

    if (stage === 'REJECTED') {
      const reason = String(note || '').trim();
      if (!reason) return bad(res, 'Reject requires note/reason', 400);
    }

    doc.workflowStage = stage;
    doc.workflowUpdatedAt = now;

    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: stage === 'REJECTED' ? 'REJECT' : 'MOVE_STAGE',
      fromStage,
      toStage: stage,
      note: note ? String(note) : null,
    });

    await doc.save();

    const out = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return ok(res, 'Stage moved', { article: withCover(out) });
  } catch (e) {
    console.error('[workflow.move] error', e?.message || e);
    return bad(res, 'Failed to move stage', 500);
  }
});

// POST /api/admin/workflow/:articleId/comment
router.post('/:articleId([0-9a-fA-F]{24})/comment', requireAdminAuth, async (req, res) => {
  try {
    const { articleId } = req.params;
    const message = String(req.body?.message || '').trim();
    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);
    if (!message) return bad(res, 'Message is required', 400);

    const doc = await News.findById(articleId);
    if (!doc) return bad(res, 'Article not found', 404);

    const now = new Date();
    const actor = getActor(req);

    doc.internalComments = Array.isArray(doc.internalComments) ? doc.internalComments : [];
    doc.internalComments.push({ at: now, byUserId: actor.byUserId, byRole: actor.byRole, message });

    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'COMMENT',
      fromStage: String(doc.workflowStage || 'DRAFT'),
      toStage: String(doc.workflowStage || 'DRAFT'),
      note: message,
    });

    doc.workflowUpdatedAt = now;
    await doc.save();

    const out = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return ok(res, 'Comment added', { article: withCover(out) });
  } catch (e) {
    console.error('[workflow.comment] error', e?.message || e);
    return bad(res, 'Failed to add comment', 500);
  }
});

// POST /api/admin/workflow/:articleId/lock (Founder only)
router.post('/:articleId([0-9a-fA-F]{24})/lock', requireFounderAuth, async (req, res) => {
  try {
    const { articleId } = req.params;
    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);
    const doc = await News.findById(articleId);
    if (!doc) return bad(res, 'Article not found', 404);

    const result = await updatePublicVisibility(doc, req, { locked: true }, 'LOCK');
    return ok(res, 'Locked', { article: withCover(result.doc), ...articleMutationMetadata(result) });
  } catch (e) {
    console.error('[workflow.lock] error', { code: e?.code || null });
    return bad(res, e.statusCode || e.status ? e.message : 'Failed to lock article', e.statusCode || e.status || 500);
  }
});

// POST /api/admin/workflow/:articleId/unlock (Founder only)
router.post('/:articleId([0-9a-fA-F]{24})/unlock', requireFounderAuth, async (req, res) => {
  try {
    const { articleId } = req.params;
    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);
    const doc = await News.findById(articleId);
    if (!doc) return bad(res, 'Article not found', 404);

    const result = await updatePublicVisibility(doc, req, { locked: false }, 'UNLOCK');
    return ok(res, 'Unlocked', { article: withCover(result.doc), ...articleMutationMetadata(result) });
  } catch (e) {
    console.error('[workflow.unlock] error', { code: e?.code || null });
    return bad(res, e.statusCode || e.status ? e.message : 'Failed to unlock article', e.statusCode || e.status || 500);
  }
});

// POST /api/admin/workflow/:articleId/embargo (Founder or Legal)
router.post('/:articleId([0-9a-fA-F]{24})/embargo', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (!(roleRaw === 'founder' || roleRaw === 'legal')) {
      return bad(res, 'Forbidden', 403);
    }

    const { articleId } = req.params;
    const embargoUntilRaw = req.body?.embargoUntil;
    const note = req.body?.note;
    if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);

    const embargoUntil = embargoUntilRaw ? new Date(embargoUntilRaw) : null;
    if (!embargoUntil || isNaN(embargoUntil)) return bad(res, 'embargoUntil must be a valid datetime', 400);

    const doc = await News.findById(articleId);
    if (!doc) return bad(res, 'Article not found', 404);

    const result = await updatePublicVisibility(doc, req, { embargoUntil }, 'EMBARGO_SET', note);
    return ok(res, 'Embargo updated', { article: withCover(result.doc), ...articleMutationMetadata(result) });
  } catch (e) {
    console.error('[workflow.embargo] error', { code: e?.code || null });
    return bad(res, e.statusCode || e.status ? e.message : 'Failed to set embargo', e.statusCode || e.status || 500);
  }
});

// DELETE /api/admin/workflow/push-history/:pushHistoryId (Founder only)
router.delete('/push-history/:pushHistoryId([0-9a-fA-F]{24})', requireFounderAuth, async (req, res) => {
  try {
    const { pushHistoryId } = req.params;
    if (!mongoose.isValidObjectId(pushHistoryId)) return bad(res, 'Invalid pushHistoryId', 400);
    const doc = await PushHistory.findByIdAndDelete(pushHistoryId);
    if (!doc) return bad(res, 'PushHistory not found', 404);
    return ok(res, 'Push history deleted', { id: pushHistoryId });
  } catch (e) {
    console.error('[workflow.pushHistory.delete] error', e?.message || e);
    return bad(res, 'Failed to delete push history', 500);
  }
});

module.exports = router;
