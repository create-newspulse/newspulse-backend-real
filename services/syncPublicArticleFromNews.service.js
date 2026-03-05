const PublicArticle = require('../models/Article');
const { canonicalizeSlug } = require('../lib/slug');

function normalizeSlug(slug) {
  return canonicalizeSlug(slug);
}

function _safeStr(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.trim() ? s : '';
}

async function syncPublicArticleFromNews(newsDoc, options = {}) {
  const logger = options.logger || console;
  if (!newsDoc) return null;

  const slug = normalizeSlug(newsDoc.slug);
  if (!slug) return null;

  const isPublished = String(newsDoc.status || '').toLowerCase() === 'published';
  const coverUrl =
    (newsDoc.coverImage && typeof newsDoc.coverImage === 'object' && !Array.isArray(newsDoc.coverImage) ? newsDoc.coverImage.url : null) ||
    newsDoc.coverImageUrl ||
    newsDoc.imageURL ||
    null;

  const coverImage = coverUrl
    ? {
        url: coverUrl,
        publicId: newsDoc.coverImage && typeof newsDoc.coverImage === 'object' ? (newsDoc.coverImage.publicId || null) : null,
        alt: newsDoc.coverImage && typeof newsDoc.coverImage === 'object' ? (newsDoc.coverImage.alt || null) : null,
      }
    : { url: null, publicId: null, alt: null };

  const update = {
    title: newsDoc.title,
    slug,
    slugs: newsDoc.slugs || null,
    summary: newsDoc.description || null,
    content: newsDoc.content || null,

    originalLang: newsDoc.language || 'en',

    // Canonical cached translations (en/hi/gu)
    translations: {
      en: {
        title: _safeStr(newsDoc?.translations?.en?.title) || null,
        summary: _safeStr(newsDoc?.translations?.en?.summary) || null,
        content: _safeStr(newsDoc?.translations?.en?.content) || null,
        generatedAt: null,
        provider: null,
      },
      hi: {
        title: _safeStr(newsDoc?.translations?.hi?.title) || null,
        summary: _safeStr(newsDoc?.translations?.hi?.summary) || null,
        content: _safeStr(newsDoc?.translations?.hi?.content) || null,
        generatedAt: null,
        provider: null,
      },
      gu: {
        title: _safeStr(newsDoc?.translations?.gu?.title) || null,
        summary: _safeStr(newsDoc?.translations?.gu?.summary) || null,
        content: _safeStr(newsDoc?.translations?.gu?.content) || null,
        generatedAt: null,
        provider: null,
      },
    },

    // Store full i18n buckets for instant language switching on public story endpoints.
    i18n: {
      title: {
        en: _safeStr(newsDoc?.translations?.en?.title) || null,
        hi: _safeStr(newsDoc?.translations?.hi?.title) || null,
        gu: _safeStr(newsDoc?.translations?.gu?.title) || null,
      },
      summary: {
        en: _safeStr(newsDoc?.translations?.en?.summary) || null,
        hi: _safeStr(newsDoc?.translations?.hi?.summary) || null,
        gu: _safeStr(newsDoc?.translations?.gu?.summary) || null,
      },
      content: {
        en: _safeStr(newsDoc?.translations?.en?.content) || null,
        hi: _safeStr(newsDoc?.translations?.hi?.content) || null,
        gu: _safeStr(newsDoc?.translations?.gu?.content) || null,
      },
    },

    translationStatus: newsDoc.translationStatus || null,
    translationError: newsDoc.translationError || null,
    translationNextRetryAt: newsDoc.translationNextRetryAt || null,

    category: newsDoc.category,
    language: newsDoc.language || 'en',
    status: isPublished ? 'published' : 'draft',
    publishedAt: isPublished ? (newsDoc.publishedAt || new Date()) : null,
    isBreaking: String(newsDoc.category || '').toLowerCase() === 'breaking',
    coverImage,
    tags: Array.isArray(newsDoc.tags) ? newsDoc.tags : [],

    // State-wise national tags (copied from News)
    stateTags: Array.isArray(newsDoc.stateTags) ? newsDoc.stateTags : [],
    stateNames: Array.isArray(newsDoc.stateNames) ? newsDoc.stateNames : [],
  };

  try {
    return await PublicArticle.findOneAndUpdate(
      { slug },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
  } catch (e) {
    try {
      logger.warn?.('[articles.syncPublicArticleFromNews] failed', { slug, message: e?.message || String(e) });
    } catch (_) {}
    return null;
  }
}

module.exports = {
  syncPublicArticleFromNews,
};
