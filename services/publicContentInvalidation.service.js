const { bumpPublicConfigVersion } = require('./publicConfigVersion.service');
const { getPublicCategoryDefinition } = require('../lib/categories');

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
  const publicCategorySlug = categoryDefinition && categoryDefinition.publicSlug ? categoryDefinition.publicSlug : null;

  const paths = _unique([
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
  ]);

  return { paths, tags };
}

async function notifyPublicContentInvalidation(payload = {}, options = {}) {
  const logger = options.logger || console;
  const reason = String(payload.reason || 'article_update').trim() || 'article_update';
  const paths = _unique((payload.paths || []).map(_normalizePath));
  const tags = _unique(payload.tags || []);

  await bumpPublicConfigVersion().catch((error) => {
    try {
      logger.warn?.('[publicContentInvalidation] version bump failed', { message: error?.message || String(error), reason });
    } catch (_) {}
  });

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
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    return { ok: true, delivered: true, reason, paths, tags };
  } catch (error) {
    try {
      logger.warn?.('[publicContentInvalidation] webhook failed', {
        message: error?.message || String(error),
        webhookUrl,
        reason,
        paths,
        tags,
      });
    } catch (_) {}
    return { ok: false, delivered: false, reason, paths, tags, error: error?.message || String(error) };
  }
}

async function notifyArticleContentInvalidation(docLike, options = {}) {
  const targets = buildArticleRevalidationTargets(docLike);
  return notifyPublicContentInvalidation({
    reason: 'article_publish',
    articleId: docLike && docLike._id ? String(docLike._id) : null,
    translationGroupId: docLike && (docLike.translationGroupId || docLike.translationKey)
      ? String(docLike.translationGroupId || docLike.translationKey)
      : null,
    paths: targets.paths,
    tags: targets.tags,
  }, options);
}

module.exports = {
  buildArticleRevalidationTargets,
  notifyPublicContentInvalidation,
  notifyArticleContentInvalidation,
};