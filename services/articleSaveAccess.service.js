const mongoose = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const News = require('../models/News');
const User = require('../models/User');
const PublicArticle = require('../models/Article');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const YouthPulseContributor = require('../models/YouthPulseContributor');
const { hasSpecialRight, normalizeRole } = require('../lib/teamAccess');
const { loadArticleMutationActor, requireFounderArticleMutation } = require('../lib/articleMutationActor');
const { newsPublishGrantIssuers, publicationDenied } = require('../lib/newsPublishGrant');
const { logAudit } = require('../lib/audit');
const { loadRoleForUser, isSafeZoneMasterLocked } = require('../middleware/requireAuth');
const { evaluateModuleAccess, getFounderModulePolicy } = require('./founderAccessPolicyService');
const { buildStoryIdentityFilter, getStoryKeys } = require('./articleSlugUniqueness.service');
const { buildPublicArticleMatch } = require('./syncPublicArticleFromNews.service');
const { isFaithTopicSyncChild } = require('./translationGroupSync.service');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');
const { buildPublicCopyFilter } = require('./articleLifecycle.service');

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

function assertCopyState(copy, source, kind, newsIds, publishing = false) {
  if (String(copy.status || '') !== String(source.status || '')) throw saveDenied();
  if (kind === 'draft' && (!newsIds.has(String(copy.sourceNewsId || ''))
    || copy.status !== (publishing ? 'published' : 'draft') || copy.deletedAt)) {
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

async function assertPublicationGrant(user, session) {
  if (isSafeZoneMasterLocked() || !hasSpecialRight(user, 'news_publish', null, isSafeZoneMasterLocked())) throw publicationDenied();
  for (const id of newsPublishGrantIssuers(user)) {
    const issuer = await User.findById(id, { role: 1, isFounder: 1 }, { session }).lean();
    if (issuer && founder(issuer)) return;
  }
  throw publicationDenied();
}

function assertUnprotectedPublication(doc) {
  const future = value => value && (!Number.isFinite(new Date(value).getTime()) || new Date(value).getTime() > Date.now());
  if (doc.status === 'scheduled' || doc.scheduledAt || doc.publishAt || doc.deletedAt
    || [doc.workflowStage, doc.workflow?.stage].some(stage => String(stage || '').toLowerCase() === 'scheduled')
    || doc.locked || doc.workflow?.locked || doc.requiresFounderApproval
    || future(doc.embargoUntil) || future(doc.workflow?.embargoUntil) || future(doc.publishedAt)
    || doc.isPrivate === true || (doc.visibility && doc.visibility !== 'public')
    || getStoryKeys(doc).length > 1) throw publicationDenied();
}

async function authorizeArticleSave(req, sourceLike, patch = {}, session, {
  publicOnly = false, checkIntent = true, faithTopicOnly = false, publicSync = true, ignoreComputed = false,
  draftTranslation = false, syncDrafts = false, publication = false, newArticle = false,
} = {}) {
  try {
    const user = await loadArticleMutationActor(req, session, publication ? publicationDenied : saveDenied);
    if (founder(user)) return null;
    if (publication) await assertPublicationGrant(user, session);
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
    const existingIds = records.map(doc => doc._id);
    if (newArticle) {
      if (records.some(doc => String(doc._id) === String(source._id))) throw scopeChanged();
      records.push(source);
      if (source.sourceArticleId && String(source.sourceArticleId) !== String(source._id)
        && !records.some(doc => String(doc._id) === String(source.sourceArticleId))) throw publicationDenied();
    }
    const ids = new Set(records.map(doc => String(doc._id)));
    if (!ids.has(String(source._id))) throw scopeChanged();
    const groupKeys = new Set(records.flatMap(getStoryKeys));
    if (publication && groupKeys.size > 1) throw publicationDenied();
    const kind = editor ? 'editor' : 'draft';
    for (const doc of records) {
      if (doc.status === 'deleted' || doc.deletedAt) throw saveDenied();
      if (publication) {
        assertUnprotectedPublication(doc);
        if (doc.sourceArticleId && !ids.has(String(doc.sourceArticleId))) throw publicationDenied();
      }
      if (draftTranslation && (doc.status !== 'draft' || doc.scheduledAt || doc.publishAt
        || doc.locked || doc.workflow?.locked
        || ['scheduled', 'published'].includes(String(doc.workflowStage || '').toLowerCase())
        || ['scheduled', 'published'].includes(String(doc.workflow?.stage || '').toLowerCase()))) throw saveDenied();
      if (!editor && (doc.status !== 'draft' || !doc.createdByUserId
        || String(doc.createdByUserId) !== String(user._id)
        || doc.locked || doc.workflow?.locked || doc.scheduledAt || doc.publishAt
        || youthSubmissionId(doc))) throw saveDenied();
    }
    const snapshots = new Map(records.map(doc => [String(doc._id), doc]));
    const publishedPlans = new Map();
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
      : syncDrafts || prospectiveRecords.some(doc => doc.status === 'published') ? prospectiveRecords : [];
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
    for (const [id, copy] of copies) {
      if (publication && (!ids.has(String(copy.sourceNewsId || ''))
        || (copy.sourceArticleId && !ids.has(String(copy.sourceArticleId)))
        || getStoryKeys(copy).some(key => !groupKeys.has(key)))) throw publicationDenied();
      assertCopyState(copy, finalCopySources.get(id), kind, ids);
    }
    if (publication) {
      const groupCopies = await PublicArticle.find(buildPublicCopyFilter(records), null, { session }).lean();
      for (const copy of groupCopies) {
        if (!copies.has(String(copy._id))
          || (copy.sourceNewsId && !ids.has(String(copy.sourceNewsId)))) throw publicationDenied();
        assertUnprotectedPublication(copy);
      }
    }
    const createdCopies = new Set();
    const writtenCopySources = new Map();
    return {
      ids: records.map(doc => doc._id),
      existingIds,
      publicationGroupKey: publication ? [...groupKeys][0] : undefined,
      guard: { $or: records.filter(doc => !newArticle || String(doc._id) !== String(source._id)).map(doc => ({
        _id: doc._id, status: doc.status, deletedAt: doc.deletedAt ?? null,
        ...Object.fromEntries(IDENTITY_FIELDS.map(field => [field, doc[field] ?? null])),
        ...(!editor ? { createdByUserId: doc.createdByUserId, locked: doc.locked ?? null } : {}),
      })) },
      assertNewsRecords(docs) {
        for (const doc of docs) {
          const previous = publishedPlans.get(String(doc._id)) || snapshots.get(String(doc._id));
          if (!previous) throw saveDenied();
          if (doc.status !== previous.status || Boolean(doc.deletedAt) !== Boolean(previous.deletedAt)) throw scopeChanged();
          if (youthSubmissionId(doc) !== youthSubmissionId(previous)) throw scopeChanged();
          for (const field of IDENTITY_FIELDS) {
            const serverSourceLink = field === 'sourceArticleId' && !previous[field]
              && (((draftTranslation || String(doc._id) === String(source._id)) && String(doc[field]) === String(source._id))
                || (publication && String(doc[field]) === String(doc._id)));
            if (!serverSourceLink && !sameValue(doc[field], previous[field])) throw scopeChanged();
          }
        }
      },
      adoptSourceIdentity(doc) {
        if (!publication || String(doc._id) !== String(source._id)) throw scopeChanged();
        const previous = snapshots.get(String(doc._id));
        if (!previous || previous.status !== doc.status || youthSubmissionId(previous) !== youthSubmissionId(doc)) throw scopeChanged();
        for (const field of IDENTITY_FIELDS) {
          if (previous[field] && !sameValue(previous[field], doc[field])) throw scopeChanged();
        }
        snapshots.set(String(doc._id), { ...previous, ...Object.fromEntries(IDENTITY_FIELDS.map(field => [field, doc[field]])) });
      },
      approvePublishedRecord(doc) {
        if (!publication) throw publicationDenied();
        const previous = snapshots.get(String(doc._id));
        if (!previous) throw publicationDenied();
        this.assertNewsRecords([{ ...plain(doc), status: previous.status, deletedAt: previous.deletedAt }]);
        if (doc.status !== 'published' || doc.deletedAt || doc.scheduledAt || doc.publishAt
          || !doc.publishedAt || (previous.publishedAt && !sameValue(previous.publishedAt, doc.publishedAt))) throw scopeChanged();
        publishedPlans.set(String(doc._id), plain(doc));
      },
      assertTranslationPlan(docs) {
        this.assertNewsRecords(docs);
        for (const doc of docs) for (const field of PUBLIC_VISIBILITY_FIELDS) {
          if (!sameValue(doc[field], snapshots.get(String(doc._id))[field])) throw scopeChanged();
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
          assertCopyState(copy, previous, kind, ids, publication && previous.status === 'published');
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
          const previous = !publication && copies.has(id) ? { ...copies.get(id), workflow: undefined } : source;
          assertCopyState(copy, previous, kind, ids, publication);
        }
      },
      async hidePublicationCopies(activeSession) {
        if (!publication) throw publicationDenied();
        const filter = copies.size ? { $or: [...copies.values()].map(copy => ({
          _id: copy._id, status: copy.status, sourceNewsId: copy.sourceNewsId ?? null,
          deletedAt: copy.deletedAt ?? null, updatedAt: copy.updatedAt ?? null,
        })) } : { _id: { $in: [] } };
        const hidden = await PublicArticle.updateMany(filter, { $set: { status: 'draft' } }, { session: activeSession });
        if (!hidden?.acknowledged || hidden.matchedCount !== copies.size) throw scopeChanged();
        for (const copy of copies.values()) copy.status = 'draft';
      },
      async verifyPublishedGroup(activeSession, currentSource) {
        if (!publication) throw publicationDenied();
        const current = await News.find(buildStoryIdentityFilter(currentSource), null, { session: activeSession }).lean();
        if (current.length !== ids.size || current.some(doc => !ids.has(String(doc._id)))) throw scopeChanged();
        this.assertNewsRecords(current);
        const currentCopies = await PublicArticle.find(buildPublicCopyFilter(current), null, { session: activeSession }).lean();
        for (const copy of currentCopies) {
          const id = String(copy._id);
          if (!copies.has(id) && !createdCopies.has(id)) throw scopeChanged();
          if (!writtenCopySources.has(id) && copy.status !== 'draft') throw scopeChanged();
        }
        await this.verifyPublicCopies(activeSession);
      },
    };
  } catch (error) {
    if (['ARTICLE_SAVE_FORBIDDEN', 'ARTICLE_PUBLISH_FORBIDDEN'].includes(error.code)) {
      await logAudit(req, 'ACCESS_BLOCKED', null, { module: 'articles', reason: publication ? 'article_publish_scope' : 'article_save_scope', result: 'blocked' });
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

function articleTranslationAuthorizer(req, { confirmOverwriteHumanEdited = false } = {}) {
  return async (source, session) => {
    if (confirmOverwriteHumanEdited) {
      await requireFounderArticleMutation(req, session);
      return null;
    }
    return authorizeArticleSave(req, source, {}, session, {
      checkIntent: false, draftTranslation: true, syncDrafts: true,
    });
  };
}

function articlePublicationAuthorizer(req, patch = {}) {
  return (source, session) => authorizeArticleSave(req, source, patch, session, {
    checkIntent: false, publication: true, syncDrafts: true,
  });
}

async function authorizeArticleCreation(req, docLike, session, { publication = false } = {}) {
  const doc = plain(docLike);
  if (publication) {
    const scope = await authorizeArticleSave(req, doc, {}, session, {
      checkIntent: false, publication: true, newArticle: true, syncDrafts: true,
    });
    if (scope?.existingIds.length) {
      const guarded = await News.updateMany(scope.guard, { $inc: { syncVersion: 1 } }, { session });
      if (!guarded.acknowledged || guarded.matchedCount !== scope.existingIds.length) throw scopeChanged();
    }
    return scope;
  }
  if (['published', 'scheduled'].includes(doc.status) || doc.scheduledAt || doc.publishAt) {
    await requireFounderArticleMutation(req, session);
    return;
  }
  try {
    const user = await loadArticleMutationActor(req, session, saveDenied);
    if (founder(user)) return;
    const linked = await News.find(buildStoryIdentityFilter(doc), null, { session })
      .select('+createdByUserId').lean();
    if (doc.sourceArticleId && String(doc.sourceArticleId) !== String(doc._id)
      && !linked.some(member => String(member._id) === String(doc.sourceArticleId))) throw saveDenied();
    let scope;
    if (linked.length) {
      scope = await articleTranslationAuthorizer(req)(linked[0], session);
      scope.assertNewsRecords(linked);
    }
    const keys = getStoryKeys(doc);
    const copies = await PublicArticle.find({ $or: [
      buildPublicArticleMatch(doc),
      ...(keys.length ? [{ translationGroupId: { $in: keys } }, { translationKey: { $in: keys } }] : []),
    ] }, null, { session }).lean();
    const ids = new Set((scope?.ids || []).map(String));
    if (copies.some(copy => copy.status !== 'draft' || copy.deletedAt || copy.scheduledAt || copy.publishAt
      || !ids.has(String(copy.sourceNewsId)))) throw saveDenied();
    if (scope) {
      const guarded = await News.updateMany(scope.guard, { $inc: { syncVersion: 1 } }, { session });
      if (!guarded.acknowledged || guarded.matchedCount !== scope.ids.length) throw scopeChanged();
    }
  } catch (error) {
    if (error.code === 'ARTICLE_SAVE_FORBIDDEN') {
      await logAudit(req, 'ACCESS_BLOCKED', null, { module: 'articles', reason: 'article_creation_linkage', result: 'blocked' });
    }
    throw error;
  }
}

module.exports = {
  authorizeArticleSave, articleSaveAuthorizer, articleTranslationAuthorizer, authorizeArticleCreation,
  articlePublicationAuthorizer,
  contentSaveBody, saveDenied, scopeChanged,
};
