const PublicArticle = require('../models/Article');
const { canonicalizeSlug } = require('../lib/slug');

function normalizeSlug(slug) {
  return canonicalizeSlug(slug);
}

function _safeStr(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.trim() ? s : '';
}

function _normalizeProvider(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'google' || s === 'openai' || s === 'manual') return s;
  return null;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _hasFullTranslationBucket(b) {
  const bucket = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  return _isNonEmptyString(bucket.title) && _isNonEmptyString(bucket.summary) && _isNonEmptyString(bucket.content);
}

function _buildTranslationBucket(src, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const s = src && typeof src === 'object' && !Array.isArray(src) ? src : {};

  const out = {
    title: _safeStr(s.title) || null,
    summary: _safeStr(s.summary) || null,
    content: _safeStr(s.content) || null,
  };

  const full = _hasFullTranslationBucket(out);

  const rawGeneratedAt = s.generatedAt;
  const generatedAt = rawGeneratedAt ? new Date(rawGeneratedAt) : null;
  if (generatedAt && !Number.isNaN(generatedAt.getTime())) {
    out.generatedAt = generatedAt;
  } else if (full) {
    out.generatedAt = now;
  }

  const provider = _normalizeProvider(s.provider);
  if (provider) {
    out.provider = provider;
  } else if (full) {
    // Ensure provider is always valid for a full bucket.
    out.provider = 'google';
  }

  return out;
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

    originalLang: newsDoc.originalLang || newsDoc.language || newsDoc.lang || 'en',

    // Canonical cached translations (en/hi/gu)
    translations: {
      en: _buildTranslationBucket(newsDoc?.translations?.en, { now: new Date() }),
      hi: _buildTranslationBucket(newsDoc?.translations?.hi, { now: new Date() }),
      gu: _buildTranslationBucket(newsDoc?.translations?.gu, { now: new Date() }),
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
    translationUpdatedAt: newsDoc.translationUpdatedAt || null,

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
    const saved = await PublicArticle.findOneAndUpdate(
      { slug },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    return saved;
  } catch (e) {
    try {
      logger.warn?.('[articles.syncPublicArticleFromNews] failed', {
        slug,
        message: e?.message || String(e),
        errorName: e?.name,
      });
    } catch (_) {}
    return null;
  }
}

module.exports = {
  syncPublicArticleFromNews,
};
