const mongoose = require('mongoose');
const { prepareAuthorBylineForPublication } = require('./authorByline.service');

const { publishCanonicalArticle } = require('./articlePublishing.service');
const { isPulseDialogueArticle } = require('./pulseDialogue.service');
const { isOrdinaryPublication } = require('./ordinaryPublicNews.service');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');
const { invalidateArticleCaches } = require('../lib/cache');
const { buildPubliclyVisibleNewsArticleFilter } = require('./publicArticleVisibility.service');

async function synchronizeOrdinaryPublication(doc, News, stats, options, logger) {
  if (!isOrdinaryPublication(doc)) return;
  let current = doc;
  const seen = new Set([String(doc._id)]);
  try {
    while (current.sourceArticleId && String(current.sourceArticleId) !== String(current._id)) {
      const parentId = String(current.sourceArticleId);
      if (seen.has(parentId)) throw new Error('Translation source cycle');
      seen.add(parentId);
      current = await News.findById(parentId);
      if (!current) throw new Error('Missing translation source');
      if (!isOrdinaryPublication(current)) return;
    }
    const visibleCount = await News.countDocuments({
      $and: [
        buildPubliclyVisibleNewsArticleFilter({ now: options.now || new Date() }),
        { _id: { $in: [...seen] } },
      ],
    });
    if (visibleCount !== seen.size) throw new Error('News source is not publicly visible');
    stats.publicSync = stats.publicSync || { ok: true, synced: 0, failedArticleIds: [] };
    const sync = options.syncPublicArticleFromNews || syncPublicArticleFromNews;
    const saved = await sync(doc, { logger, preserveExistingProjection: true });
    if (!saved?._id) throw new Error('Public projection synchronization failed');
    stats.publicSync.synced += 1;
  } catch (_) {
    stats.publicSync = stats.publicSync || { ok: true, synced: 0, failedArticleIds: [] };
    stats.publicSync.ok = false;
    stats.publicSync.failedArticleIds.push(String(doc._id));
    logger.warn?.('[scheduler] ordinary public synchronization failed', {
      code: 'PUBLIC_ARTICLE_SYNC_FAILED', sourceNewsId: String(doc._id),
    });
  }
  try {
    const invalidate = options.invalidateArticleCaches || invalidateArticleCaches;
    await invalidate();
  } catch (_) {
    logger.warn?.('[scheduler] ordinary cache invalidation failed', {
      code: 'PUBLIC_CACHE_INVALIDATION_FAILED', sourceNewsId: String(doc._id),
    });
  }
}

async function publishDueScheduledArticles(options = {}) {
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 50;

  if (mongoose.connection.readyState !== 1 && !options.allowDisconnected) {
    return { processed: 0, published: 0, failed: 0, skipped: 0 };
  }

  const News = options.News || require('../models/News');
  const PushHistory = options.PushHistory || require('../models/PushHistory');
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
  const publishedPulseGroups = new Set();
  const authorSnapshots = new Map();

  for (const doc of candidates || []) {
    stats.processed += 1;
    try {
      if (isPulseDialogueArticle(doc)) {
        const groupKey = String(doc.translationGroupId || doc.translationKey || doc._id || '').trim();
        if (groupKey && publishedPulseGroups.has(groupKey)) {
          stats.skipped += 1;
          continue;
        }
        await publishArticle(doc, {
          actor: { byUserId: null, byRole: 'SYSTEM' },
          reason: 'Auto-published by scheduler',
          source: 'scheduler',
          now,
          logger,
        });
        if (groupKey) publishedPulseGroups.add(groupKey);
        stats.published += 1;
        continue;
      }

      const bylineGroup = String(doc.translationGroupId || doc.translationKey || doc._id);
      let bylineSource = doc;
      if (authorSnapshots.has(bylineGroup)) {
        doc.authorByline = authorSnapshots.get(bylineGroup);
      } else {
        if (doc.authorByline?.enabled && doc.sourceArticleId && String(doc.sourceArticleId) !== String(doc._id)) {
          bylineSource = await News.findById(doc.sourceArticleId);
          if (!bylineSource) throw new Error('Author byline source article not found');
        }
        await prepareAuthorBylineForPublication(bylineSource, now);
        if (bylineSource !== doc) {
          doc.authorByline = bylineSource.authorByline || { enabled: false };
        }
      }
      const fromStage = String(doc.workflowStage || 'SCHEDULED');
      doc.status = 'published';
      doc.publishedAt = now;
      doc.publishAt = null;
      doc.workflowStage = 'PUBLISHED';
      doc.workflowUpdatedAt = now;
      doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
      doc.workflowHistory.push({
        at: now,
        byUserId: null,
        byRole: 'SYSTEM',
        action: 'PUBLISH',
        fromStage,
        toStage: 'PUBLISHED',
        note: 'Auto-published by scheduler',
      });
      await doc.save();
      if (bylineSource !== doc) {
        await News.updateOne({ _id: bylineSource._id }, { $set: { authorByline: doc.authorByline } });
      }
      if (doc.authorByline !== undefined) authorSnapshots.set(bylineGroup, doc.authorByline);

      await synchronizeOrdinaryPublication(doc, News, stats, options, logger);

      try {
        await PushHistory.create({
          articleId: doc._id,
          slug: doc.slug,
          title: doc.title,
          channel: 'SITE',
          at: now,
          byUserId: null,
          status: 'SUCCESS',
          meta: { source: 'scheduler' },
        });
      } catch (e) {
        logger.warn?.('[scheduler][pushHistory] create failed', e?.message || e);
      }
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
};