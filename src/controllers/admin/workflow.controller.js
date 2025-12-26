const mongoose = require('mongoose');

const Article = require('../../../models/News');
const WorkflowEvent = require('../../../models/WorkflowEvent');
const PushHistory = require('../../../models/PushHistory');
const AuditLog = require('../../../models/AuditLog');

const STAGE_ORDER = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
];

const STAGE_ORDER_LOWER = [
  'draft',
  'copy_edit',
  'legal_review',
  'editor_approval',
  'founder_approval',
  'scheduled',
  'published',
];

function ok(res, message, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, message, data });
}

function bad(res, message, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, success: false, status, message, data: null, ...extra });
}

function toObjectIdOrNull(value) {
  try {
    if (value && mongoose.isValidObjectId(value)) return new mongoose.Types.ObjectId(value);
  } catch (_) {}
  return null;
}

function getActorUserId(req) {
  return toObjectIdOrNull(req.admin && req.admin.id);
}

function normalizeStage(value) {
  const s = String(value || '').trim().toUpperCase();
  return s;
}

function normalizeStageLower(value) {
  return String(value || '').trim().toLowerCase();
}

function stageFromLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();

  // Accept snake_case
  if (STAGE_ORDER_LOWER.includes(lower)) return lower;

  // Accept uppercase legacy
  const upper = raw.toUpperCase();
  if (STAGE_ORDER.includes(upper)) return upper.toLowerCase();

  // Accept Draft/CopyEdit/... (admin panel)
  const compact = raw.replace(/\s+/g, '').trim();
  const map = {
    Draft: 'draft',
    CopyEdit: 'copy_edit',
    LegalReview: 'legal_review',
    EditorApproval: 'editor_approval',
    FounderApproval: 'founder_approval',
    Scheduled: 'scheduled',
    Published: 'published',
  };
  if (map[compact]) return map[compact];

  // Accept Draft-like casing variants
  const cap = compact[0]?.toUpperCase() + compact.slice(1);
  if (map[cap]) return map[cap];

  return '';
}

function labelFromStageLower(stageLower) {
  const s = String(stageLower || '').trim().toLowerCase();
  const map = {
    draft: 'Draft',
    copy_edit: 'CopyEdit',
    legal_review: 'LegalReview',
    editor_approval: 'EditorApproval',
    founder_approval: 'FounderApproval',
    scheduled: 'Scheduled',
    published: 'Published',
  };
  return map[s] || s;
}

function riskLabelFromDoc(doc) {
  const explicit = String(doc?.riskLabel || '').trim();
  if (explicit) return explicit;
  const r = String(doc?.workflow?.risk || 'UNKNOWN').toUpperCase();
  if (r === 'LOW') return 'Low';
  if (r === 'MEDIUM') return 'Medium';
  if (r === 'HIGH') return 'High';
  return 'Unknown';
}

function toActor(admin) {
  if (!admin) return { id: null, email: null, role: null };
  return {
    id: admin.id ? String(admin.id) : null,
    email: admin.email ? String(admin.email) : null,
    role: admin.role ? String(admin.role) : null,
  };
}

function getCurrentStage(articleDocOrObj) {
  const wf = articleDocOrObj && articleDocOrObj.workflow;
  const stage = normalizeStage(wf && wf.stage);
  if (STAGE_ORDER.includes(stage)) return stage;

  // Backward compatibility: older workflow fields
  const legacy = normalizeStage(articleDocOrObj && articleDocOrObj.workflowStage);
  if (STAGE_ORDER.includes(legacy)) return legacy;

  // Status fallback
  const status = String(articleDocOrObj && articleDocOrObj.status || '').toLowerCase();
  if (status === 'published') return 'PUBLISHED';
  if (status === 'scheduled') return 'SCHEDULED';
  return 'DRAFT';
}

function getCurrentStageLower(articleDocOrObj) {
  // Prefer canonical lower workflowStage if present
  const s0 = normalizeStageLower(articleDocOrObj && articleDocOrObj.workflowStage);
  const mapped0 = stageFromLabel(s0);
  if (mapped0 && STAGE_ORDER_LOWER.includes(mapped0)) return mapped0;

  // Fallback: derive from workflow.stage or status
  const upper = getCurrentStage(articleDocOrObj);
  return String(upper).toLowerCase();
}

function computeToStage(fromStage, direction, toStage) {
  const idx = STAGE_ORDER.indexOf(fromStage);
  if (idx < 0) throw new Error('Invalid current stage');

  if (direction === 'next') {
    if (fromStage === 'PUBLISHED') throw new Error('Cannot move next from PUBLISHED');
    return STAGE_ORDER[Math.min(idx + 1, STAGE_ORDER.length - 1)];
  }

  if (direction === 'back') {
    if (fromStage === 'PUBLISHED') throw new Error('Cannot move back from PUBLISHED');
    return STAGE_ORDER[Math.max(idx - 1, 0)];
  }

  if (direction === 'to') {
    const target = normalizeStage(toStage);
    if (!STAGE_ORDER.includes(target)) throw new Error('Invalid toStage');
    if (fromStage === 'PUBLISHED' && target !== 'PUBLISHED') throw new Error('Cannot move from PUBLISHED without unpublish');
    if (target === fromStage) return target;

    const tIdx = STAGE_ORDER.indexOf(target);
    if (Math.abs(tIdx - idx) !== 1) {
      throw new Error(`Invalid stage transition: ${fromStage} -> ${target}`);
    }
    return target;
  }

  throw new Error('Invalid direction');
}

function withWorkflow(obj) {
  if (!obj) return obj;
  const stage = getCurrentStage(obj);
  const workflow = obj.workflow || {};
  return {
    ...obj,
    workflow: {
      stage,
      risk: workflow.risk || 'UNKNOWN',
      locked: workflow.locked ?? obj.locked ?? false,
      embargoUntil: workflow.embargoUntil ?? obj.embargoUntil ?? null,
      lastMovedAt: workflow.lastMovedAt ?? obj.workflowUpdatedAt ?? null,
      lastMovedBy: workflow.lastMovedBy ?? null,
      notes: Array.isArray(workflow.notes) ? workflow.notes : [],
    },
  };
}

async function getWorkflowQueue(req, res) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return ok(res, 'Workflow queue (db not connected)', { items: [], page: 1, limit: 50, total: 0 });
    }

    const stageRaw = String(req.query.stage || '').trim();
    const qRaw = String(req.query.q || '').trim();
    const searchRaw = String(req.query.search || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const skip = (page - 1) * limit;
    const language = String(req.query.language || '').trim();
    const category = String(req.query.category || '').trim();

    const filter = { status: { $ne: 'deleted' } };

    if (language) filter.language = language;
    if (category) filter.category = category;

    const stageLower = stageFromLabel(stageRaw);
    if (stageLower) {
      if (!STAGE_ORDER_LOWER.includes(stageLower)) return bad(res, 'Invalid stage', 400);

      const stageUpper = stageLower.toUpperCase();
      if (stageLower === 'draft') {
        filter.$or = [
          { workflowStage: 'draft' },
          { workflowStage: 'DRAFT' },
          { workflowStage: { $exists: false } },
          { 'workflow.stage': 'DRAFT' },
          { 'workflow.stage': { $exists: false } },
        ];
      } else {
        filter.$or = [
          { workflowStage: stageLower },
          { workflowStage: stageUpper },
          { 'workflow.stage': stageUpper },
        ];
      }
    }

    const search = searchRaw || qRaw;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = (filter.$and || []).concat([
        { $or: [{ title: rx }, { description: rx }, { content: rx }, { slug: rx }] },
      ]);
    }

    const [itemsRaw, total] = await Promise.all([
      Article.find(filter)
        .sort({ workflowStageEnteredAt: -1, 'workflow.lastMovedAt': -1, workflowUpdatedAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Article.countDocuments(filter),
    ]);

    const items = (itemsRaw || []).map((d) => {
      const stageLower2 = getCurrentStageLower(d);
      const stageEnteredAt = d.workflowStageEnteredAt || d.workflow?.lastMovedAt || d.workflowUpdatedAt || d.updatedAt || d.createdAt || null;
      return {
        _id: d._id,
        title: d.title,
        language: d.language || 'en',
        riskLabel: riskLabelFromDoc(d),
        stage: labelFromStageLower(stageLower2),
        stageEnteredAt,
        updatedAt: d.updatedAt || null,
        authorName: d.authorName || null,
      };
    });

    return ok(res, 'Workflow queue', { items, page, limit, total });
  } catch (e) {
    console.error('[workflow.queue] error', e?.message || e);
    return bad(res, 'Failed to load workflow queue', 500);
  }
}

async function getWorkflowBoard(req, res) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return ok(res, 'Workflow board (db not connected)', { mode: 'simple', columns: {} });
    }

    const mode = String(req.query.mode || 'simple').toLowerCase() === 'advanced' ? 'advanced' : 'simple';

    const makeCard = (d) => {
      const stageLower = getCurrentStageLower(d);
      const stageEnteredAt = d.workflowStageEnteredAt || d.workflow?.lastMovedAt || d.workflowUpdatedAt || d.updatedAt || d.createdAt || null;
      return {
        _id: d._id,
        title: d.title,
        language: d.language || 'en',
        riskLabel: riskLabelFromDoc(d),
        stage: labelFromStageLower(stageLower),
        stageEnteredAt,
        updatedAt: d.updatedAt || null,
        authorName: d.authorName || null,
      };
    };

    const limitPerColumn = 200;

    if (mode === 'simple') {
      const [drafts, scheduled, published] = await Promise.all([
        Article.find({ status: { $ne: 'deleted' }, $or: [{ workflowStage: 'draft' }, { workflowStage: 'DRAFT' }, { 'workflow.stage': 'DRAFT' }, { workflowStage: { $exists: false } }] })
          .sort({ workflowStageEnteredAt: -1, updatedAt: -1 })
          .limit(limitPerColumn)
          .lean(),
        Article.find({ status: { $ne: 'deleted' }, $or: [{ workflowStage: 'scheduled' }, { workflowStage: 'SCHEDULED' }, { 'workflow.stage': 'SCHEDULED' }] })
          .sort({ workflowStageEnteredAt: -1, updatedAt: -1 })
          .limit(limitPerColumn)
          .lean(),
        Article.find({ status: { $ne: 'deleted' }, $or: [{ workflowStage: 'published' }, { workflowStage: 'PUBLISHED' }, { 'workflow.stage': 'PUBLISHED' }, { status: 'published' }] })
          .sort({ workflowStageEnteredAt: -1, updatedAt: -1 })
          .limit(limitPerColumn)
          .lean(),
      ]);

      return ok(res, 'Workflow board', {
        mode,
        columns: {
          draftsToReview: (drafts || []).map(makeCard),
          scheduled: (scheduled || []).map(makeCard),
          published: (published || []).map(makeCard),
        },
      });
    }

    const stages = ['draft', 'copy_edit', 'legal_review', 'editor_approval', 'founder_approval', 'scheduled'];
    const queries = stages.map((s) => {
      const up = s.toUpperCase();
      const q = s === 'draft'
        ? { status: { $ne: 'deleted' }, $or: [{ workflowStage: 'draft' }, { workflowStage: 'DRAFT' }, { 'workflow.stage': 'DRAFT' }, { workflowStage: { $exists: false } }] }
        : { status: { $ne: 'deleted' }, $or: [{ workflowStage: s }, { workflowStage: up }, { 'workflow.stage': up }] };
      return Article.find(q).sort({ workflowStageEnteredAt: -1, updatedAt: -1 }).limit(limitPerColumn).lean();
    });

    const results = await Promise.all(queries);
    const columns = {};
    stages.forEach((s, idx) => {
      columns[s] = (results[idx] || []).map(makeCard);
    });

    return ok(res, 'Workflow board', { mode, columns });
  } catch (e) {
    console.error('[workflow.board] error', e?.message || e);
    return bad(res, 'Failed to load workflow board', 500);
  }
}

async function getWorkflowArticle(req, res) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return ok(res, 'Workflow article (db not connected)', { article: null, events: [], pushHistory: [] });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return bad(res, 'Invalid article id', 400);

    const [articleRaw, eventsRaw, pushRaw] = await Promise.all([
      Article.findById(id).lean(),
      WorkflowEvent.find({ articleId: id }).sort({ at: -1 }).limit(200).lean(),
      PushHistory.find({ articleId: id }).sort({ at: -1 }).limit(50).lean(),
    ]);

    if (!articleRaw) return bad(res, 'Article not found', 404);

    const article = withWorkflow(articleRaw);
    const events = (eventsRaw || []).map((e) => ({
      id: String(e._id),
      articleId: String(e.articleId),
      fromStage: e.fromStage,
      toStage: e.toStage,
      action: e.action,
      by: e.by,
      at: e.at,
      meta: e.meta || null,
    }));

    const pushHistory = (pushRaw || []).map((p) => ({
      id: String(p._id),
      articleId: String(p.articleId),
      titleSnapshot: p.titleSnapshot ?? p.title ?? null,
      slugSnapshot: p.slugSnapshot ?? p.slug ?? null,
      language: p.language ?? null,
      category: p.category ?? null,
      pushedTo: p.pushedTo ?? 'PUBLIC_SITE',
      status: p.status,
      error: p.error ?? null,
      at: p.at,
      by: p.by ?? p.byUserId ?? null,
    }));

    return ok(res, 'Workflow article', { article, events, pushHistory });
  } catch (e) {
    console.error('[workflow.article] error', e?.message || e);
    return bad(res, 'Failed to load workflow article', 500);
  }
}

async function patchWorkflowStage(req, res) {
  const actorId = getActorUserId(req);
  const roleRaw = String(req.admin && req.admin.role || 'admin').toLowerCase();
  const byRole = roleRaw === 'founder' ? 'FOUNDER' : (roleRaw === 'legal' ? 'LEGAL' : (roleRaw === 'staff' ? 'STAFF' : 'EDITOR'));

  try {
    if (mongoose.connection.readyState !== 1) {
      return bad(res, 'Database not connected', 503);
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return bad(res, 'Invalid article id', 400);

    const actionRaw = String(req.body?.action || req.body?.direction || '').trim();
    const toStageRaw = req.body?.toStage;
    const note = req.body?.note;

    // support { action: next|back|set } from admin panel + legacy direction=to
    const action = actionRaw === 'set' ? 'set' : (actionRaw === 'to' ? 'set' : actionRaw);
    if (!['next', 'back', 'set'].includes(action)) {
      return bad(res, 'action must be next|back|set', 400);
    }

    const doc = await Article.findById(id);
    if (!doc) return bad(res, 'Article not found', 404);

    // enforce locks/embargo for non-founder
    const locked = !!(doc.workflow?.locked ?? doc.locked);
    if (locked && roleRaw !== 'founder') return bad(res, 'Article is locked', 409);
    const embargoUntil = doc.workflow?.embargoUntil ?? doc.embargoUntil;
    if (embargoUntil && new Date(embargoUntil) > new Date() && roleRaw !== 'founder') {
      return bad(res, `Article is embargoed until ${new Date(embargoUntil).toISOString()}`, 409);
    }

    const fromLower = getCurrentStageLower(doc);
    const fromUpper = fromLower.toUpperCase();

    let toLower = '';
    if (action === 'set') {
      if (roleRaw !== 'admin' && roleRaw !== 'founder') {
        return bad(res, 'Forbidden', 403);
      }
      toLower = stageFromLabel(toStageRaw);
      if (!toLower || !STAGE_ORDER_LOWER.includes(toLower)) {
        return bad(res, 'Invalid stage transition', 400);
      }
    } else {
      const idx = STAGE_ORDER_LOWER.indexOf(fromLower);
      if (idx < 0) return bad(res, 'Invalid stage transition', 400);
      if (action === 'next') {
        if (fromLower === 'published') return bad(res, 'Invalid stage transition', 400);
        toLower = STAGE_ORDER_LOWER[Math.min(idx + 1, STAGE_ORDER_LOWER.length - 1)];
      } else {
        if (fromLower === 'published') return bad(res, 'Invalid stage transition', 400);
        toLower = STAGE_ORDER_LOWER[Math.max(idx - 1, 0)];
      }
    }

    // Enforce adjacent moves for next/back (already) and default set to any stage.
    const toUpper = toLower.toUpperCase();

    // prepare legacy workflowHistory role hook
    doc.__byRoleForHistory = byRole;

    const now = new Date();

    // canonical stage update
    doc.workflow = doc.workflow || {};
    // workflow.stage is legacy and uses UPPER enums
    doc.workflow.stage = toUpper;
    doc.workflow.lastMovedAt = now;
    doc.workflow.lastMovedBy = actorId;
    doc.workflow.notes = Array.isArray(doc.workflow.notes) ? doc.workflow.notes : [];
    if (note) {
      doc.workflow.notes.push({ at: now, by: actorId, text: String(note).slice(0, 2000) });
    }

    // keep legacy fields aligned
    // canonical storage for admin panel
    doc.workflowStage = toLower;
    doc.workflowUpdatedAt = now;
    doc.workflowStageEnteredAt = now;
    doc.locked = doc.workflow.locked ?? doc.locked;
    doc.embargoUntil = doc.workflow.embargoUntil ?? doc.embargoUntil;

    // status sync
    if (toUpper === 'PUBLISHED') {
      doc.status = 'published';
      doc.publishedAt = now;
      doc.publishAt = null;
      doc.scheduledAt = null;
    } else if (toUpper === 'SCHEDULED') {
      doc.status = 'scheduled';
    } else {
      if (doc.status !== 'archived' && doc.status !== 'deleted') {
        doc.status = 'draft';
      }
    }

    // legacy workflowHistory
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actorId,
      byRole,
      action: 'MOVE_STAGE',
      fromStage: fromLower,
      toStage: toLower,
      note: note ? String(note).slice(0, 2000) : null,
    });

    // save article + audit event
    await doc.save();

    try {
      await WorkflowEvent.create({
        articleId: doc._id,
        fromStage: fromUpper,
        toStage: toUpper,
        action: 'MOVE_STAGE',
        by: actorId,
        at: now,
        meta: { action, toStage: toLower, note: note ? String(note).slice(0, 2000) : null },
      });
    } catch (e) {
      console.warn('[workflow.event] create failed', e?.message || e);
    }

    try {
      await AuditLog.create({
        action: 'workflow_stage',
        key: String(doc._id),
        before: { workflowStage: fromLower, status: String(doc.status || '') },
        after: { workflowStage: toLower, status: String(doc.status || '') },
        actor: toActor(req.admin),
        ip: req.ip || null,
        userAgent: String(req.headers['user-agent'] || '') || null,
        meta: { note: note ? String(note).slice(0, 2000) : null },
      });
    } catch (e) {
      console.warn('[auditLog.workflow_stage] create failed', e?.message || e);
    }

    // Always log a push history record for stage transitions
    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'workflow',
        action: 'edit',
        titleSnapshot: doc.title || null,
        slugSnapshot: doc.slug || null,
        language: doc.language || null,
        category: doc.category || null,
        pushedTo: 'PUBLIC_SITE',
        status: 'SUCCESS',
        error: null,
        at: now,
        by: actorId,
        byUserId: actorId,
        // back-compat mirrors
        title: doc.title || null,
        slug: doc.slug || null,
        channel: 'SITE',
        meta: {
          oldStage: fromLower,
          newStage: toLower,
          oldStatus: null,
          newStatus: null,
          source: 'workflow-stage',
        },
      });
    } catch (e) {
      console.warn('[pushHistory.workflow] create failed', e?.message || e);
    }

    const out = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    delete out.__byRoleForHistory;
    return ok(res, 'Workflow stage updated', {
      articleId: String(doc._id),
      workflowStage: doc.workflowStage,
      workflowStageEnteredAt: doc.workflowStageEnteredAt,
      workflowUpdatedAt: doc.workflowUpdatedAt,
    });
  } catch (e) {
    console.error('[workflow.stage] error', e?.message || e);
    return bad(res, 'Failed to update stage', 500);
  }
}

module.exports = {
  getWorkflowQueue,
  getWorkflowBoard,
  getWorkflowArticle,
  patchWorkflowStage,
};
