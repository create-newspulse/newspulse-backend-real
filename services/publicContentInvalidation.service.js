const { bumpPublicConfigVersion } = require('./publicConfigVersion.service');
const { getPublicCategoryDefinition, getCanonicalPublicCategoryKey } = require('../lib/categories');
const mongoose = require('mongoose');
const EditorialTopic = require('../models/EditorialTopic');
const { invalidateArticleCaches } = require('../lib/cache');

function _normalizePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function _unique(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function buildArticleRevalidationTargets(docLike) {
  const doc = docLike && typeof docLike === 'object' ? docLike : {};
  const slugs = doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs) ? doc.slugs : {};
  const fallbackSlug = String(doc.slug || '').trim() || null;
  const category = String(doc.category || '').trim().toLowerCase() || null;
  const translationGroupId = String(doc.translationGroupId || doc.translationKey || '').trim() || null;
  const articleId = doc._id ? String(doc._id) : null;
  const categoryDefinition = category ? getPublicCategoryDefinition(category) : null;
  const publicCategorySlug = categoryDefinition?.publicSlug || getCanonicalPublicCategoryKey(category);

  const paths = _unique([
    '/', '/hi', '/gu', '/latest', '/hi/latest', '/gu/latest',
    '/search', '/hi/search', '/gu/search',
    fallbackSlug ? `/news/${fallbackSlug}` : null,
    slugs.en ? `/news/${slugs.en}` : null,
    slugs.hi ? `/hi/news/${slugs.hi}` : null,
    slugs.gu ? `/gu/news/${slugs.gu}` : null,
    publicCategorySlug ? `/category/${publicCategorySlug}` : null,
    publicCategorySlug ? `/hi/category/${publicCategorySlug}` : null,
    publicCategorySlug ? `/gu/category/${publicCategorySlug}` : null,
  ].map(_normalizePath));

  const tags = _unique([
    articleId ? `article:${articleId}` : null,
    translationGroupId ? `translation-group:${translationGroupId}` : null,
    category ? `category:${category}` : null,
    publicCategorySlug ? `category-page:${publicCategorySlug}` : null,
    'articles',
    'article-detail',
    'related-stories',
    'latest-stories',
    'homepage',
    'public-news',
    'search',
    'editorial-topics',
    'trending-topics',
  ]);

  return { paths, tags };
}

async function notifyPublicContentInvalidation(payload = {}, options = {}) {
  const logger = options.logger || console;
  const reason = String(payload.reason || 'article_update').trim() || 'article_update';
  const paths = _unique((payload.paths || []).map(_normalizePath));
  const tags = _unique(payload.tags || []);

  try {
    await bumpPublicConfigVersion();
  } catch (error) {
    logger.warn?.('[publicContentInvalidation] version bump failed', { reason });
    return { ok: false, delivered: false, reason, paths, tags, error: 'Public version update failed' };
  }

  const webhookUrl = String(
    process.env.PUBLIC_CONTENT_REVALIDATE_URL
    || process.env.PUBLIC_REVALIDATE_URL
    || process.env.FRONTEND_REVALIDATE_URL
    || ''
  ).trim();

  if (!webhookUrl || typeof fetch !== 'function') {
    return { ok: true, delivered: false, reason, paths, tags };
  }

  const token = String(
    process.env.PUBLIC_CONTENT_REVALIDATE_TOKEN
    || process.env.PUBLIC_REVALIDATE_TOKEN
    || process.env.FRONTEND_REVALIDATE_TOKEN
    || ''
  ).trim();

  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-revalidate-token'] = token;
  }

  const body = {
    reason,
    paths,
    tags,
    articleId: payload.articleId ? String(payload.articleId) : null,
    translationGroupId: payload.translationGroupId ? String(payload.translationGroupId) : null,
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Revalidation endpoint returned HTTP ${res.status}`);
    }

    return { ok: true, delivered: true, reason, paths, tags };
  } catch (error) {
    try {
      logger.warn?.('[publicContentInvalidation] webhook failed', {
        code: error?.name === 'TimeoutError' ? 'PUBLIC_REVALIDATION_TIMEOUT' : 'PUBLIC_REVALIDATION_FAILED',
        reason,
        paths,
        tags,
      });
    } catch (_) {}
    return { ok: false, delivered: false, reason, paths, tags, error: 'Public revalidation delivery failed' };
  }
}

async function notifyArticleContentInvalidation(docLike, options = {}) {
  const targets = buildArticleRevalidationTargets(docLike);
  return notifyPublicContentInvalidation({
    reason: options.reason || 'article_publish',
    articleId: docLike && docLike._id ? String(docLike._id) : null,
    translationGroupId: docLike && (docLike.translationGroupId || docLike.translationKey)
      ? String(docLike.translationGroupId || docLike.translationKey)
      : null,
    paths: targets.paths,
    tags: targets.tags,
  }, options);
}

async function invalidateArticleContent(docs, options = {}) {
  const allDocs = [...(Array.isArray(docs) ? docs : [docs]), ...(options.previousDocs || [])].filter(Boolean);
  const logger = options.logger || console;
  const failures = [];
  try {
    await invalidateArticleCaches({ publicVisibilityRemoved: options.publicVisibilityRemoved === true });
  } catch (error) {
    failures.push('ARTICLE_CACHE_INVALIDATION_FAILED');
    logger.warn('[publicContentInvalidation] cache eviction failed', { reason: options.reason });
  }
  const targets = allDocs.map(buildArticleRevalidationTargets);
  const paths = targets.flatMap(target => target.paths);
  const tags = targets.flatMap(target => target.tags);
  const articleIds = allDocs.map(doc => doc._id).filter(id => id && mongoose.isValidObjectId(String(id)));
  const articleTags = _unique(allDocs.flatMap(doc => Array.isArray(doc.tags) ? doc.tags : []));
  const topicSlugs = [...(options.topicSlugs || [])];
  const clauses = [];
  if (articleIds.length) clauses.push({ pinnedArticleId: { $in: articleIds } });
  if (articleTags.length) clauses.push({ articleTags: { $in: articleTags } });
  if (clauses.length && mongoose.connection.readyState === 1) {
    try {
      const topics = await EditorialTopic.find({ $or: clauses }).select('slug').lean();
      topicSlugs.push(...topics.map(topic => topic.slug));
    } catch (error) {
      failures.push('TOPIC_REVALIDATION_LOOKUP_FAILED');
      logger.warn('[publicContentInvalidation] topic lookup failed', { reason: options.reason });
    }
  }
  for (const slug of _unique(topicSlugs)) {
    paths.push(`/topic/${slug}`, `/hi/topic/${slug}`, `/gu/topic/${slug}`);
    tags.push(`topic:${slug}`, `editorial-topic:${slug}`);
  }
  const result = await notifyPublicContentInvalidation({
    reason: options.reason || 'article_update',
    articleId: allDocs[0]?._id,
    translationGroupId: allDocs[0]?.translationGroupId || allDocs[0]?.translationKey,
    paths, tags,
  }, options);
  return {
    ...result,
    ok: result.ok && failures.length === 0,
    ...(failures.length ? { failures } : {}),
    ...(!result.ok || failures.length ? {
      code: 'PUBLIC_REVALIDATION_FAILED',
      message: 'Content changed, but public revalidation is incomplete. Reload the saved state; do not repeat the mutation.',
    } : {}),
  };
}

module.exports = {
  buildArticleRevalidationTargets,
  notifyPublicContentInvalidation,
  notifyArticleContentInvalidation,
  invalidateArticleContent,
};