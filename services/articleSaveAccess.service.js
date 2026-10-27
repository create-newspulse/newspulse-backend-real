const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const YouthPulseContributor = require('../models/YouthPulseContributor');
const { hasSpecialRight, normalizeRole } = require('../lib/teamAccess');
const { loadArticleMutationActor } = require('../lib/articleMutationActor');
const { logAudit } = require('../lib/audit');
const { loadRoleForUser, isSafeZoneMasterLocked } = require('../middleware/requireAuth');
const { evaluateModuleAccess, getFounderModulePolicy } = require('./founderAccessPolicyService');
const { buildStoryIdentityFilter } = require('./articleSlugUniqueness.service');
const { buildPublicArticleMatch } = require('./syncPublicArticleFromNews.service');
const { isFaithTopicSyncChild } = require('./translationGroupSync.service');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');

const CONTROL_FIELDS = new Set([
  '_id', 'id', 'status', 'scheduledAt', 'publishAt', 'publishedAt', 'deletedAt', 'deletedFromStatus',
  'locked', 'embargoUntil', 'visibility', 'isPrivate', 'publicVisibilityRefreshAt',
  'workflow', 'workflowStage', 'workflowStageEnteredAt', 'workflowUpdatedAt', 'workflowHistory',
  'requiresFounderApproval', 'sourceArticleId', 'sourceNewsId', 'translationGroupId', 'translationKey',
  'sourceLanguage', 'sourceType', 'youthPulseSubmissionId', 'youthPulseContributorId', 'communityReportId',
  'syncMode', 'syncVersion', 'lastSyncedAt', 'contentFingerprint', 'machineGenerated', 'humanEdited',
  'translationReviewStatus', 'translationMeta',
  'createdAt', 'updatedAt', '__v',
]);
const COMPUTED_FIELDS = new Set([
  '_id', 'id', 'syncVersion', 'lastSyncedAt', 'contentFingerprint', 'publicVisibilityRefreshAt',
  'machineGenerated', 'humanEdited', 'translationReviewStatus', 'translationMeta', 'createdAt', 'updatedAt', '__v',
]);
const IDENTITY_FIELDS = ['sourceArticleId', 'translationGroupId', 'translationKey'];
const PUBLIC_VISIBILITY_FIELDS = ['status', 'publishedAt', 'publishAt', 'scheduledAt', 'deletedAt', 'locked', 'embargoUntil', 'visibility', 'isPrivate'];
const valueAt = (doc, path) => path.split('.').reduce((value, field) => value?.[field], doc);
const plain = doc => typeof doc?.toObject === 'function' ? doc.toObject() : doc;
const founder = user => normalizeRole(user?.role) === 'founder' || user?.isFounder === true;
const youthSubmissionId = doc => String(doc?.sourceType || '').trim().toLowerCase() === 'youth_pulse'
  && mongoose.isValidObjectId(String(doc.youthPulseSubmissionId || '')) ? String(doc.youthPulseSubmissionId) : null;

function saveDenied() {
  return Object.assign(new Error('An authorized Editor or Founder is required to save this article and its linked records.'), {
    status: 403, statusCode: 403, code: 'ARTICLE_SAVE_FORBIDDEN',
  });
}

function scopeChanged() {
  return Object.assign(new Error('Article save scope changed. Reload and retry.'), {
    status: 409, statusCode: 409, code: 'ARTICLE_SAVE_SCOPE_CHANGED',
  });
}

function sameValue(left, right) {
  if (left == null && right == null) return true;
  if (left instanceof Date || right instanceof Date) return new Date(left).getTime() === new Date(right).getTime();
  const normalize = value => value == null ? null : JSON.parse(JSON.stringify(value));
  return isDeepStrictEqual(normalize(left), normalize(right));
}

function contentSaveBody(body, docLike, isFounder = false, { ignoreComputed = false } = {}) {
  if (isFounder) return { ...body };
  const doc = plain(docLike) || {};
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (key.startsWith('$') || key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw saveDenied();
    if (ignoreComputed && COMPUTED_FIELDS.has(key.split('.')[0])) continue;
    if (!CONTROL_FIELDS.has(key.split('.')[0])) {
      out[key] = value;
      continue;
    }
    const previous = key === 'id' ? String(doc._id || '') : valueAt(doc, key);
    const supplied = key === 'status' && typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (!sameValue(supplied, previous)) throw saveDenied();
  }
  return out;
}

function assertCopyState(copy, source, kind, newsIds) {
  if (String(copy.status || '') !== String(source.status || '')) throw saveDenied();
  if (kind === 'draft' && (!newsIds.has(String(copy.sourceNewsId || '')) || copy.status !== 'draft' || copy.deletedAt)) {
    throw saveDenied();
  }
  // Content editing cannot remove a visibility gate through a derived public-copy write.
  const next = {
    ...source,
    locked: source.locked === true || source.workflow?.locked === true,
    embargoUntil: [source.embargoUntil, source.workflow?.embargoUntil].filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null,
  };
  for (const field of PUBLIC_VISIBILITY_FIELDS.filter(key => key !== 'status')) {
    if (field === 'publishedAt' && source.status === 'published' && !source.publishedAt) continue;
    const oldValue = copy[field];
    const newValue = next[field];
    if (oldValue == null || oldValue === false) {
      if (newValue == null || newValue === false) continue;
    }
    if (!sameValue(oldValue, newValue)) throw saveDenied();
  }
}

async function authorizeArticleSave(req, sourceLike, patch = {}, session, {
  publicOnly = false, checkIntent = true, faithTopicOnly = false, publicSync = true, ignoreComputed = false,
} = {}) {
  try {
    const user = await loadArticleMutationActor(req, session, saveDenied);
    if (founder(user)) return null;
    if (isSafeZoneMasterLocked()) throw saveDenied();
    const source = plain(sourceLike);
    if (!source) throw scopeChanged();
    if (checkIntent) contentSaveBody(req.body, source, false, { ignoreComputed });
    const policy = await getFounderModulePolicy({ readOnly: true, session });
    const canManage = evaluateModuleAccess(user, 'manageNews', policy).allowed;
    const role = canManage && user.specialRightsConfigured !== true ? await loadRoleForUser(user, { session }) : null;
    const editor = canManage && hasSpecialRight(user, 'news_edit', role, isSafeZoneMasterLocked());
    const workspace = ['addNews', 'draftDesk'].some(key => evaluateModuleAccess(user, key, policy).allowed);
    if (!editor && (!workspace || publicOnly)) throw saveDenied();
    if (source.status === 'deleted' || source.deletedAt) throw saveDenied();
    if (publicOnly) return { filter: { _id: source._id, status: source.status, updatedAt: source.updatedAt ?? null } };

    const prospective = { ...source, ...patch };
    const records = await News.find({
      $or: [buildStoryIdentityFilter(source), buildStoryIdentityFilter(prospective)],
    }, null, { session }).select('+createdByUserId').lean();
    const ids = new Set(records.map(doc => String(doc._id)));
    if (!ids.has(String(source._id))) throw scopeChanged();
    const kind = editor ? 'editor' : 'draft';
    for (const doc of records) {
      if (doc.status === 'deleted' || doc.deletedAt) throw saveDenied();
      if (!editor && (doc.status !== 'draft' || !doc.createdByUserId
        || String(doc.createdByUserId) !== String(user._id)
        || doc.locked || doc.workflow?.locked || doc.scheduledAt || doc.publishAt
        || youthSubmissionId(doc))) throw saveDenied();
    }
    const snapshots = new Map(records.map(doc => [String(doc._id), doc]));
    const youth = new Map();
    for (const doc of records) {
      const id = youthSubmissionId(doc);
      if (!id) continue;
      const submission = await YouthPulseSubmission.findById(id, null, { session }).lean();
      youth.set(String(doc._id), submission);
      if (submission?.contributorId) {
        await YouthPulseContributor.findById(submission.contributorId, null, { session }).select('_id').lean();
      }
    }
    const prospectiveRecords = records.map(doc => String(doc._id) === String(source._id) ? { ...doc, ...patch } : doc);
    const publicRecords = !publicSync ? [] : faithTopicOnly
      ? prospectiveRecords.filter(doc => String(doc._id) === String(source._id) || isFaithTopicSyncChild(prospective, doc))
      : prospectiveRecords.some(doc => doc.status === 'published') ? prospectiveRecords : [];
    const now = new Date();
    publicRecords.sort((a, b) =>
      Number(isPubliclyVisibleNewsArticle(a, { now })) - Number(isPubliclyVisibleNewsArticle(b, { now })));
    const publicOrder = new Map(publicRecords.map((doc, index) => [String(doc._id), index]));
    const copies = new Map();
    const finalCopySources = new Map();
    for (const doc of publicRecords) {
      const matches = await PublicArticle.find(buildPublicArticleMatch(doc, {
        previousDoc: String(doc._id) === String(source._id) ? source : undefined,
      }), null, { session }).lean();
      for (const copy of matches) {
        copies.set(String(copy._id), copy);
        finalCopySources.set(String(copy._id), doc);
      }
    }
    for (const [id, copy] of copies) assertCopyState(copy, finalCopySources.get(id), kind, ids);
    const createdCopies = new Set();
    const writtenCopySources = new Map();
    return {
      ids: records.map(doc => doc._id),
      guard: { $or: records.map(doc => ({
        _id: doc._id, status: doc.status, deletedAt: doc.deletedAt ?? null,
        ...Object.fromEntries(IDENTITY_FIELDS.map(field => [field, doc[field] ?? null])),
        ...(!editor ? { createdByUserId: doc.createdByUserId, locked: doc.locked ?? null } : {}),
      })) },
      assertNewsRecords(docs) {
        for (const doc of docs) {
          const previous = snapshots.get(String(doc._id));
          if (!previous) throw saveDenied();
          if (doc.status !== previous.status || Boolean(doc.deletedAt) !== Boolean(previous.deletedAt)) throw scopeChanged();
          if (youthSubmissionId(doc) !== youthSubmissionId(previous)) throw scopeChanged();
          for (const field of IDENTITY_FIELDS) {
            const serverSourceLink = field === 'sourceArticleId' && !previous[field]
              && String(doc._id) === String(source._id) && String(doc[field]) === String(source._id);
            if (!serverSourceLink && !sameValue(doc[field], previous[field])) throw scopeChanged();
          }
        }
      },
      bindNewsDocument(doc) {
        if (doc.$locals) doc.$locals.articleSaveScope = this;
      },
      assertYouthPulseSubmission(doc, submission) {
        this.assertNewsRecords([doc]);
        const previous = youth.get(String(doc._id));
        if (String(previous?._id || '') !== String(submission?._id || '')
          || String(previous?.contributorId || '') !== String(submission?.contributorId || '')) throw scopeChanged();
      },
      orderPublicRecords(docs) {
        if (docs.length !== publicOrder.size || docs.some(doc => !publicOrder.has(String(doc._id)))) throw scopeChanged();
        return [...docs].sort((a, b) => publicOrder.get(String(a._id)) - publicOrder.get(String(b._id)));
      },
      async publicWriteTarget(doc, filter, activeSession) {
        const matches = await PublicArticle.find(filter, null, { session: activeSession }).lean();
        for (const copy of matches) {
          if (!copies.has(String(copy._id)) && !createdCopies.has(String(copy._id))) throw saveDenied();
          const previous = writtenCopySources.get(String(copy._id))
            || { ...copies.get(String(copy._id)), workflow: undefined };
          assertCopyState(copy, previous, kind, ids);
        }
        if (matches.length) {
          const copy = matches[0];
          writtenCopySources.set(String(copy._id), plain(doc));
          return {
            filter: { $and: [filter, { _id: copy._id, status: copy.status }] },
            upsert: false,
          };
        }
        const id = new mongoose.Types.ObjectId();
        createdCopies.add(String(id));
        writtenCopySources.set(String(id), plain(doc));
        return { filter: { _id: id }, upsert: true };
      },
      async verifyPublicCopies(activeSession) {
        for (const [id, source] of writtenCopySources) {
          const copy = await PublicArticle.findById(id, null, { session: activeSession }).lean();
          if (!copy) throw scopeChanged();
          const previous = copies.has(id) ? { ...copies.get(id), workflow: undefined } : source;
          assertCopyState(copy, previous, kind, ids);
        }
      },
    };
  } catch (error) {
    if (error.code === 'ARTICLE_SAVE_FORBIDDEN') {
      await logAudit(req, 'ACCESS_BLOCKED', null, { module: 'articles', reason: 'article_save_scope', result: 'blocked' });
    }
    throw error;
  }
}

function articleSaveAuthorizer(req, patch = {}, { followUp = false, faithTopicOnly = false } = {}) {
  return (source, session, transaction) => authorizeArticleSave(req, source, patch, session, {
    checkIntent: !followUp && !transaction.saveIntentValidated,
    publicSync: !followUp, faithTopicOnly, ignoreComputed: true,
  });
}

module.exports = { authorizeArticleSave, articleSaveAuthorizer, contentSaveBody, saveDenied, scopeChanged };
