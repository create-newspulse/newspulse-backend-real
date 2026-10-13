const mongoose = require('mongoose');
const { publishCanonicalArticle } = require('./articlePublishing.service');
const { withActiveArticleSource } = require('./articleLifecycle.service');
const { syncTranslationGroupMetadata } = require('./translationGroupSync.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');

async function refreshDuePublicArticleVisibility(options = {}) {
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const stats = { processed: 0, refreshed: 0, failed: 0, skipped: 0 };
  if (mongoose.connection.readyState !== 1) return { ...stats, unavailable: true };
  const News = require('../models/News');
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
    stats.processed += 1;
    const key = String(candidate.translationGroupId || candidate.translationKey || candidate.sourceArticleId || candidate._id);
    if (seen.has(key)) { stats.skipped += 1; continue; }
    seen.add(key);
    try {
      const result = await withActiveArticleSource(candidate._id, async (current, session) => {
        if (current.status !== 'published') return null;
        if (Object.hasOwn(current, 'publicVisibilityRefreshAt')) {
          if (!current.publicVisibilityRefreshAt || new Date(current.publicVisibilityRefreshAt) > now) return null;
        } else if (![current.embargoUntil, current.workflow?.embargoUntil, current.publishAt, current.scheduledAt]
          .some(value => value != null && new Date(value) <= now)) return null;
        return syncTranslationGroupMetadata(current, { session, now, invalidate: false });
      });
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

  const News = options.News || require('../models/News');
  const publishArticle = options.publishCanonicalArticle || publishCanonicalArticle;

  const candidatesQuery = News.find({
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
    stats.processed += 1;
    try {
      const groupKey = String(doc.translationGroupId || doc.translationKey || doc.sourceArticleId || doc._id || '').trim();
      if (publishedGroups.has(groupKey)) {
        stats.skipped += 1;
        continue;
      }
      await publishArticle(doc, {
        actor: { byUserId: null, byRole: 'SYSTEM' },
        reason: 'Auto-published by scheduler', source: 'scheduler', now, logger,
      });
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