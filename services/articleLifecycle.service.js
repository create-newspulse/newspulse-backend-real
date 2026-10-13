const mongoose = require('mongoose');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const EditorialTopic = require('../models/EditorialTopic');
const TranslationJob = require('../models/TranslationJob');
const AuditLog = require('../models/AuditLog');
const PushHistory = require('../models/PushHistory');
const { logAudit } = require('../lib/audit');
const {
  buildStoryIdentityFilter, getStoryKeys, getStorySlugs, assertArticleSlugsUnique, UNOWNED_PUBLIC_COPY_FILTER,
} = require('./articleSlugUniqueness.service');
const { syncPublicArticleFromNews, syncNewsTranslationBuckets } = require('./syncPublicArticleFromNews.service');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');

const STAGES = { draft: 'DRAFT', scheduled: 'SCHEDULED', published: 'PUBLISHED', archived: 'ARCHIVED', deleted: 'REJECTED' };

function failure(status, message, code = 'ARTICLE_LIFECYCLE_FAILED') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function assertFounder(req) {
  if (String(req?.admin?.role || '').toLowerCase() !== 'founder') {
    throw failure(403, 'Founder permission is required.', 'FOUNDER_REQUIRED');
  }
}

function serializeNewsArticle(doc) {
  if (!doc) return doc;
  const value = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : doc;
  return { ...value, body: value.content, id: value._id == null ? null : String(value._id) };
}

function articleMutationMetadata(result) {
  const revalidationFailed = result?.revalidation?.ok === false;
  const warnings = result?.postCommitWarnings || [];
  return revalidationFailed || warnings.length ? {
    committed: true,
    ...(revalidationFailed ? { revalidation: result.revalidation } : {}),
    ...(warnings.length ? { postCommitWarnings: warnings } : {}),
  } : {};
}

async function runPostCommit(result, effect) {
  try {
    await effect();
  } catch (error) {
    console.error('[articles.lifecycle] post-commit follow-up failed', { code: error.code || 'ARTICLE_FOLLOW_UP_FAILED' });
    result.postCommitWarnings = [...(result.postCommitWarnings || []), {
      code: 'ARTICLE_FOLLOW_UP_FAILED',
      message: 'The article change committed, but a follow-up failed. Reload the saved state; do not repeat the mutation.',
    }];
  }
}

async function afterArticleCommit(options, result, effect) {
  if (options.session) options.afterCommit.push(() => runPostCommit(result, effect));
  else await runPostCommit(result, effect);
}

async function inArticleTransaction(work, options = {}) {
  if (options.session) {
    if (!Array.isArray(options.afterCommit)) throw new Error('Article transaction requires a post-commit queue');
    return work(options.session, options);
  }
  const session = await mongoose.startSession();
  const transaction = { session, afterCommit: [] };
  let result;
  try {
    await session.withTransaction(async () => {
      transaction.afterCommit.length = 0;
      result = await work(session, transaction);
    });
  } finally {
    try {
      await session.endSession();
    } catch (error) {
      console.warn('[articles.lifecycle] session cleanup failed', { code: error.code || 'SESSION_CLEANUP_FAILED' });
    }
  }
  for (const effect of transaction.afterCommit) {
    await runPostCommit(result, effect);
  }
  return result;
}

async function withActiveArticleSource(id, work, options = {}) {
  return inArticleTransaction(async (session, transaction) => {
    const source = await News.findById(id, null, { session }).lean();
    if (!source || source.status === 'deleted' || source.deletedAt) {
      throw failure(409, 'The source story was deleted. Translation was cancelled.', 'TRANSLATION_SOURCE_CHANGED');
    }
    // Every edition takes the same write dependency, serializing generation and group deletion.
    const guard = await News.updateMany(
      { ...buildStoryIdentityFilter(source), status: { $ne: 'deleted' }, deletedAt: null },
      { $inc: { syncVersion: 1 } }, { session }
    );
    if (!guard.acknowledged || !(guard.matchedCount > 0)) {
      throw failure(409, 'The source story changed. Retry the operation.', 'TRANSLATION_SOURCE_CHANGED');
    }
    return work(source, session, transaction);
  }, options);
}

async function findArticleGroup(id, session) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw failure(400, 'Invalid article id');
  let seed = await News.findById(id, null, { session }).lean();
  if (!seed) {
    const copy = await PublicArticle.findById(id, null, { session }).select('sourceNewsId').lean();
    if (copy?.sourceNewsId) seed = await News.findById(copy.sourceNewsId, null, { session }).lean();
  }
  if (!seed) throw failure(404, 'Article not found');
  const docs = await News.find(buildStoryIdentityFilter(seed), null, { session }).lean();
  if (!docs.some(doc => String(doc._id) === String(seed._id))) {
    throw failure(409, 'Article group changed. Reload and retry.');
  }
  return { seed, docs };
}

function buildPublicCopyFilter(docs) {
  const ids = docs.map(doc => doc._id);
  const keys = [...new Set(docs.flatMap(getStoryKeys))];
  const slugs = [...new Set(docs.flatMap(getStorySlugs))];
  const clauses = [{ sourceNewsId: { $in: ids } }, { sourceArticleId: { $in: ids } }];
  if (keys.length) clauses.push(
    { translationGroupId: { $in: keys } }, { translationKey: { $in: keys } }
  );
  if (slugs.length) clauses.push({
    ...UNOWNED_PUBLIC_COPY_FILTER,
    $or: ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu'].map(field => ({ [field]: { $in: slugs } })),
  });
  return { $or: clauses };
}

function historyEntry(doc, status, action, req, now) {
  const actorId = req?.admin?.id;
  return {
    at: now,
    byUserId: actorId && mongoose.isValidObjectId(String(actorId)) ? actorId : null,
    byRole: String(req?.admin?.role || 'system').toUpperCase(),
    action, fromStage: doc.workflowStage || STAGES[doc.status] || 'DRAFT',
    toStage: STAGES[status],
    note: typeof req?.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
  };
}

async function updateMember(doc, patch, action, req, now, session) {
  const updated = await News.findOneAndUpdate(
    { _id: doc._id, status: doc.status },
    {
      $set: { ...patch, workflowStage: STAGES[patch.status], workflowUpdatedAt: now },
      $inc: { syncVersion: 1 },
      $push: { workflowHistory: historyEntry(doc, patch.status, action, req, now) },
    },
    { new: true, runValidators: false, session }
  ).lean();
  if (!updated) throw failure(409, 'Article group changed. Reload and retry.');
  return updated;
}

function restoredStatus(doc) {
  if (Object.hasOwn(STAGES, doc.deletedFromStatus) && doc.deletedFromStatus !== 'deleted') return doc.deletedFromStatus;
  const deletion = [...(doc.workflowHistory || [])].reverse()
    .find(entry => (entry.toStage === 'REJECTED' || entry.action === 'REJECT')
      && ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'].includes(String(entry.fromStage || '').toUpperCase()));
  const previous = Object.keys(STAGES).find(status => status !== 'deleted' && STAGES[status] === String(deletion?.fromStage || '').toUpperCase());
  return previous || null;
}

async function recordLifecycleHistory(result, options, restoring = false) {
  const actorId = options.req?.admin?.id;
  const byUserId = actorId && mongoose.isValidObjectId(String(actorId)) ? actorId : null;
  for (const doc of result.docs) {
    const before = result.previousDocs.find(previous => String(previous._id) === String(doc._id));
    if (before?.status === doc.status) continue;
    const action = restoring ? (doc.status === 'published' ? 'publish' : 'edit')
      : { draft: 'unpublish', archived: 'archive', deleted: 'delete', scheduled: 'schedule' }[doc.status];
    try {
      await PushHistory.create({
        articleId: doc._id, type: 'publish', action, slug: doc.slug, title: doc.title,
        language: doc.language || doc.lang, category: doc.category,
        channel: 'SITE', at: options.now || new Date(), byUserId, status: 'SUCCESS',
        meta: {
          source: restoring ? 'restore' : action,
          oldStatus: before?.status, newStatus: doc.status,
          oldStage: before?.workflowStage, newStage: doc.workflowStage,
        },
      });
    } catch (error) {
      console.warn('[articles.lifecycle] push history failed', { articleId: String(doc._id), code: error.code });
    }
    if (doc.category === 'editorial' && options.req) {
      const event = restoring ? 'RESTORED'
        : { draft: 'UNPUBLISHED', archived: 'ARCHIVED', deleted: 'DELETED', scheduled: 'SCHEDULED' }[doc.status];
      await logAudit(options.req, `EDITORIAL_ARTICLE_${event}`, String(doc._id), {
        module: 'articles', targetType: 'article', targetId: String(doc._id),
        oldValue: before?.status, newValue: doc.status, editorialType: doc.editorialType,
      });
    }
  }
}

async function changeArticleGroupStatus(id, status, options = {}) {
  if (!['draft', 'archived', 'deleted', 'scheduled'].includes(status)) throw failure(400, 'Invalid lifecycle status');
  if (options.founderOnly) assertFounder(options.req);
  const now = options.now || new Date();
  if (status === 'scheduled' && (!(options.scheduledAt instanceof Date) || Number.isNaN(options.scheduledAt.getTime()))) {
    throw failure(400, 'A valid scheduledAt is required');
  }
  return inArticleTransaction(async (session, transaction) => {
    const { seed, docs } = await findArticleGroup(id, session);
    if (status === 'draft' && docs.some(doc => doc.status === 'published')) assertFounder(options.req);
    if (status !== 'deleted' && docs.some(doc => doc.status === 'deleted')) {
      throw failure(409, 'Restore the deleted story before changing its status.');
    }
    const updated = [];
    for (const doc of docs) {
      const patch = { status };
      if (status === 'deleted') {
        patch.deletedAt = doc.deletedAt || now;
        patch.deletedFromStatus = doc.status === 'deleted' ? doc.deletedFromStatus || null : doc.status;
      } else {
        patch.deletedAt = null;
        patch.publishAt = status === 'scheduled' ? options.scheduledAt : null;
        patch.scheduledAt = patch.publishAt;
      }
      const action = { deleted: 'REJECT', draft: 'UNPUBLISH', scheduled: 'SCHEDULE' }[status] || 'MOVE_STAGE';
      updated.push(await updateMember(doc, patch, action, options.req, now, session));
    }
    const copies = await PublicArticle.updateMany(buildPublicCopyFilter(docs), {
      $set: {
        status, deletedAt: status === 'deleted' ? now : null,
        ...(status === 'deleted' ? {} : {
          publishAt: status === 'scheduled' ? options.scheduledAt : null,
          scheduledAt: status === 'scheduled' ? options.scheduledAt : null,
        }),
      },
    }, { session, runValidators: false });
    if (copies?.acknowledged === false) throw failure(503, 'Public article synchronization failed.');
    const result = {
      docs: updated, previousDocs: [...docs, ...(options.previousDocs || [])],
      doc: serializeNewsArticle(updated.find(doc => String(doc._id) === String(seed._id))),
      changedCount: updated.length, changedIds: updated.map(doc => String(doc._id)),
    };
    transaction.afterCommit.push(async () => {
      await recordLifecycleHistory(result, options);
      result.revalidation = await invalidateArticleContent(result.docs, {
        previousDocs: result.previousDocs, reason: `article_${status}`, publicVisibilityRemoved: true,
      });
    });
    return result;
  }, options);
}

async function restoreArticleGroup(id, options = {}) {
  return inArticleTransaction(async (session, transaction) => {
    const { seed, docs } = await findArticleGroup(id, session);
    if (docs.some(doc => doc.status !== 'deleted')) {
      throw failure(409, 'Only a completely soft-deleted story can be restored.');
    }
    const restoreFallbackIds = [];
    const statuses = docs.map(doc => {
      const status = restoredStatus(doc);
      if (!status) restoreFallbackIds.push(String(doc._id));
      return status || 'draft';
    });
    if (statuses.includes('published')) assertFounder(options.req);
    const languages = docs.map(doc => String(doc.language || doc.lang || '').toLowerCase()).filter(Boolean);
    if (new Set(languages).size !== languages.length) {
      throw failure(409, 'The translation group has duplicate language records. Resolve them before restoring.');
    }
    for (const doc of docs) await assertArticleSlugsUnique(doc, { session });
    const now = options.now || new Date();
    const updated = [];
    for (const [index, doc] of docs.entries()) {
      if (statuses[index] === 'published' && (!doc.title || !doc.description || !doc.content || !doc.slug || !doc.publishedAt)) {
        throw failure(409, 'The previous publication is incomplete. Review the story before restoring.');
      }
      updated.push(await updateMember(doc, {
        status: statuses[index], deletedAt: null, deletedFromStatus: null,
      }, 'RESTORE', options.req, now, session));
    }
    await syncNewsTranslationBuckets(updated, { session, now });
    // A legacy shared slug can have one compatibility copy; an eligible edition must win.
    const ordered = [...updated].sort((a, b) =>
      Number(isPubliclyVisibleNewsArticle(a, { now })) - Number(isPubliclyVisibleNewsArticle(b, { now })));
    for (const doc of ordered) {
      if (doc.slug) await syncPublicArticleFromNews(doc, { session, groupDocs: updated, throwOnError: true, now });
    }
    const result = {
      docs: updated, previousDocs: docs, restoreFallbackIds,
      doc: serializeNewsArticle(updated.find(doc => String(doc._id) === String(seed._id))),
      changedCount: updated.length, changedIds: updated.map(doc => String(doc._id)),
    };
    transaction.afterCommit.push(async () => {
      if (result.restoreFallbackIds.length) {
        console.warn('[articles.restore] Legacy pre-delete status unknown; restored as draft', { articleIds: result.restoreFallbackIds });
      }
      await recordLifecycleHistory(result, options, true);
      result.revalidation = await invalidateArticleContent(result.docs, {
        previousDocs: result.previousDocs, reason: 'article_restore', publicVisibilityRemoved: true,
      });
    });
    return result;
  }, options);
}

async function permanentlyDeleteArticleGroups(ids, options = {}) {
  assertFounder(options.req);
  return inArticleTransaction(async (session, transaction) => {
    const seeds = options.allDeleted
      ? await News.find({ status: 'deleted' }, null, { session }).select('_id').lean()
      : (Array.isArray(ids) ? ids : [ids]).map(id => ({ _id: id }));
    const byId = new Map();
    for (const seed of seeds) {
      if (byId.has(String(seed._id))) continue;
      const group = await findArticleGroup(seed._id, session);
      if (group.docs.some(doc => doc.status !== 'deleted')) {
        throw failure(409, 'Only completely soft-deleted stories can be permanently removed.');
      }
      for (const doc of group.docs) byId.set(String(doc._id), doc);
    }
    const docs = [...byId.values()];
    if (!docs.length) return { deletedCount: 0, publicDeletedCount: 0, deletedIds: [] };
    const articleIds = docs.map(doc => doc._id);
    const copyFilter = buildPublicCopyFilter(docs);
    const copies = await PublicArticle.find(copyFilter, null, { session }).select('_id slug slugs category translationGroupId tags').lean();
    const topics = await EditorialTopic.find({ pinnedArticleId: { $in: articleIds } }, null, { session }).select('slug').lean();
    await EditorialTopic.updateMany({ pinnedArticleId: { $in: articleIds } }, { $set: { pinnedArticleId: null } }, { session });
    await TranslationJob.deleteMany({ newsId: { $in: articleIds } }, { session });
    const publicDeleted = await PublicArticle.deleteMany(copyFilter, { session });
    if (publicDeleted.acknowledged === false) throw failure(503, 'Public copy deletion was not acknowledged.');
    const deleted = await News.deleteMany({ _id: { $in: articleIds }, status: 'deleted' }, { session });
    if (deleted.deletedCount !== articleIds.length) throw failure(409, 'Article group changed. Reload and retry.');
    await AuditLog.create([{
      action: 'ARTICLE_PERMANENT_DELETE', module: 'articles', targetType: 'story',
      targetId: String(articleIds[0]), result: 'success',
      actor: { id: String(options.req.admin.id || ''), role: 'founder' },
      meta: {
        articleIds: articleIds.map(String), publicArticleIds: copies.map(doc => String(doc._id)),
        translationGroupIds: [...new Set(docs.flatMap(getStoryKeys))],
      },
    }], { session });
    const result = {
      deletedCount: deleted.deletedCount, publicDeletedCount: publicDeleted.deletedCount,
      deletedIds: docs.map(doc => String(doc._id)),
    };
    transaction.afterCommit.push(async () => {
      result.revalidation = await invalidateArticleContent(docs, {
        previousDocs: copies, topicSlugs: topics.map(topic => topic.slug),
        reason: 'article_permanent_delete', publicVisibilityRemoved: true,
      });
    });
    return result;
  }, options);
}

module.exports = {
  buildPublicCopyFilter, findArticleGroup, changeArticleGroupStatus,
  restoreArticleGroup, permanentlyDeleteArticleGroups,
  withActiveArticleSource, inArticleTransaction, afterArticleCommit, serializeNewsArticle, articleMutationMetadata,
};
