const mongoose = require('mongoose');
const News = require('../models/News');
const { publishCanonicalArticle } = require('./articlePublishing.service');
const { withActiveArticleSource, inArticleTransaction } = require('./articleLifecycle.service');
const { syncTranslationGroupMetadata } = require('./translationGroupSync.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');

async function refreshDuePublicArticleVisibility(options = {}) {
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const stats = { processed: 0, refreshed: 0, failed: 0, skipped: 0 };
  if (mongoose.connection.readyState !== 1) return { ...stats, unavailable: true };
  const candidates = await News.find({
    status: 'published',
    $or: [
      { publicVisibilityRefreshAt: { $ne: null, $lte: now } },
      {
        publicVisibilityRefreshAt: { $exists: false },
        $or: ['embargoUntil', 'workflow.embargoUntil', 'publishAt', 'scheduledAt']
          .map(field => ({ [field]: { $ne: null, $lte: now } })),
      },
    ],
  }).sort({ publicVisibilityRefreshAt: 1, _id: 1 }).limit(50)
    .select('_id translationGroupId translationKey sourceArticleId').lean();
  const seen = new Set();
  for (const candidate of candidates) {
    if (options.signal?.aborted || options.isStopping?.()) break;
    stats.processed += 1;
    const key = String(candidate.translationGroupId || candidate.translationKey || candidate.sourceArticleId || candidate._id);
    if (seen.has(key)) { stats.skipped += 1; continue; }
    seen.add(key);
    try {
      const result = await inArticleTransaction(async (session, transaction) => {
        const current = await News.findById(candidate._id, null, { session }).lean();
        if (!current || current.status !== 'published' || current.deletedAt) return null;
        if (Object.hasOwn(current, 'publicVisibilityRefreshAt')) {
          if (!current.publicVisibilityRefreshAt || new Date(current.publicVisibilityRefreshAt) > now) return null;
        } else if (![current.embargoUntil, current.workflow?.embargoUntil, current.publishAt, current.scheduledAt]
          .some(value => value != null && new Date(value) <= now)) return null;
        return withActiveArticleSource(current._id, source =>
          syncTranslationGroupMetadata(source, { ...transaction, now, invalidate: false }), transaction);
      }, { signal: options.signal });
      if (!result) { stats.skipped += 1; continue; }
      await invalidateArticleContent(result.docs, {
        previousDocs: result.previousDocs, reason: 'article_visibility_refresh',
        publicVisibilityRemoved: true, logger,
      });
      stats.refreshed += 1;
    } catch (error) {
      stats.failed += 1;
      logger.warn?.('[scheduler] visibility refresh failed', {
        articleId: String(candidate._id), code: error?.code || null,
      });
    }
  }
  return stats;
}

async function publishDueScheduledArticles(options = {}) {
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 50;

  if (mongoose.connection.readyState !== 1 && !options.allowDisconnected) {
    return { processed: 0, published: 0, failed: 0, skipped: 0 };
  }

  const candidatesModel = options.News || News;
  const publishArticle = options.publishCanonicalArticle || publishCanonicalArticle;

  const candidatesQuery = candidatesModel.find({
    status: 'scheduled',
    scheduledAt: { $lte: now },
    $and: [
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
    ],
  }).limit(limit);

  const candidates = typeof candidatesQuery.then === 'function' ? await candidatesQuery : candidatesQuery;
  const stats = { processed: 0, published: 0, failed: 0, skipped: 0 };
  const publishedGroups = new Set();

  for (const doc of candidates || []) {
    if (options.signal?.aborted || options.isStopping?.()) break;
    stats.processed += 1;
    try {
      const groupKey = String(doc.translationGroupId || doc.translationKey || doc.sourceArticleId || doc._id || '').trim();
      if (publishedGroups.has(groupKey)) {
        stats.skipped += 1;
        continue;
      }
      const published = await inArticleTransaction(async (session, transaction) => {
        const current = await News.findById(doc._id, null, { session }).lean();
        const scheduledAt = current?.scheduledAt ? new Date(current.scheduledAt) : null;
        if (!current || current.status !== 'scheduled' || current.deletedAt
          || !scheduledAt || !Number.isFinite(scheduledAt.getTime()) || scheduledAt > now
          || current.locked === true || (current.embargoUntil && new Date(current.embargoUntil) > now)) return false;
        return withActiveArticleSource(current._id, async source => {
          await publishArticle(source, {
            ...transaction,
            actor: { byUserId: null, byRole: 'SYSTEM' },
            reason: 'Auto-published by scheduler', source: 'scheduler', now, logger,
          });
          return true;
        }, transaction);
      }, { signal: options.signal });
      if (!published) {
        stats.skipped += 1;
        continue;
      }
      publishedGroups.add(groupKey);
      stats.published += 1;
    } catch (e) {
      stats.failed += 1;
      logger.warn?.('[scheduler] publish candidate failed', e?.message || e);
    }
  }

  return stats;
}

module.exports = {
  publishDueScheduledArticles,
  refreshDuePublicArticleVisibility,
};