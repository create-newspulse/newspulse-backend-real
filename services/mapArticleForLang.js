const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const s0 = String(v ?? '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _normalizeProvider(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'google';
  if (s === 'google' || s === 'openai' || s === 'manual') return s;
  return 'google';
}

function _pickSummary(docLike) {
  // News uses `description`, Public Article uses `summary`.
  if (docLike && typeof docLike.summary === 'string') return docLike.summary;
  if (docLike && typeof docLike.description === 'string') return docLike.description;
  return '';
}

function _hasFullBucket(bucket) {
  const b = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
  return _isNonEmptyString(b.title) && _isNonEmptyString(b.summary) && _isNonEmptyString(b.content);
}

function _getBaseLang(article) {
  return normalizeLang(article?.originalLang) || normalizeLang(article?.lang || article?.language) || 'en';
}

function _getSlugForLang(article, lang) {
  const desired = normalizeLang(lang);
  if (!desired) return null;

  const slugs = article?.slugs && typeof article.slugs === 'object' && !Array.isArray(article.slugs)
    ? article.slugs
    : null;
  const localized = slugs?.[desired];
  return _isNonEmptyString(localized) ? String(localized).trim() : null;
}

function _getBaseSlug(article) {
  if (_isNonEmptyString(article?.slug)) return String(article.slug).trim();
  const base = _getBaseLang(article);
  return _getSlugForLang(article, base) || null;
}

function _hasUsableTranslation(article, lang, { allowMissingStatus = false } = {}) {
  const desired = normalizeLang(lang);
  if (!desired) return false;

  const bucket = article?.translations?.[desired];
  if (!_hasFullBucket(bucket)) return false;

  const rawStatus = article?.translationStatus?.[desired];
  const status = rawStatus === null || rawStatus === undefined ? null : String(rawStatus).trim().toLowerCase();
  if (status === 'ready') return true;
  if (allowMissingStatus && !status) return true;
  return false;
}

// Strict mapper for feeds:
// - If desired == original => emit original fields
// - Else emit cached translation ONLY when ready + complete
// - Else null (caller should filter out)
function mapArticleForLang(article, lang) {
  const desired = normalizeLang(lang);
  if (!desired) return null;
  if (!article || typeof article !== 'object') return null;

  const base = _getBaseLang(article);

  const originalBucket = article?.translations?.[base];
  const originalProvider = _normalizeProvider(originalBucket?.provider || 'manual');
  const originalGeneratedAt = originalBucket?.generatedAt || article?.publishedAt || article?.createdAt || null;

  if (desired === base) {
    return {
      lang: desired,
      title: String(article.title || ''),
      summary: String(_pickSummary(article) || ''),
      content: String(article.content || ''),
      provider: originalProvider,
      generatedAt: originalGeneratedAt,
      isTranslated: false,
      resolvedLang: base,
    };
  }

  const bucket = article?.translations?.[desired];
  if (!_hasUsableTranslation(article, desired)) return null;

  return {
    lang: desired,
    title: String(bucket.title || ''),
    summary: String(bucket.summary || ''),
    content: String(bucket.content || ''),
    provider: _normalizeProvider(bucket.provider),
    generatedAt: bucket.generatedAt || article?.publishedAt || article?.createdAt || null,
    isTranslated: true,
    resolvedLang: desired,
  };
}

function localizeArticleForLang(article, lang, { fallbackToBase = false, allowMissingStatus = true } = {}) {
  const desired = normalizeLang(lang);
  if (!desired) return null;
  if (!article || typeof article !== 'object') return null;

  const base = _getBaseLang(article);
  const baseSlug = _getBaseSlug(article);
  const localizedSlug = _getSlugForLang(article, desired) || baseSlug;

  const originalBucket = article?.translations?.[base];
  const originalProvider = _normalizeProvider(originalBucket?.provider || 'manual');
  const originalGeneratedAt = originalBucket?.generatedAt || article?.publishedAt || article?.createdAt || null;

  if (desired === base) {
    return {
      requestedLang: desired,
      resolvedLang: base,
      lang: base,
      title: String(article.title || ''),
      summary: String(_pickSummary(article) || ''),
      content: String(article.content || ''),
      slug: localizedSlug,
      canonicalSlug: localizedSlug,
      provider: originalProvider,
      generatedAt: originalGeneratedAt,
      isTranslated: false,
    };
  }

  const bucket = article?.translations?.[desired];
  if (_hasUsableTranslation(article, desired, { allowMissingStatus })) {
    return {
      requestedLang: desired,
      resolvedLang: desired,
      lang: desired,
      title: String(bucket.title || ''),
      summary: String(bucket.summary || ''),
      content: String(bucket.content || ''),
      slug: localizedSlug,
      canonicalSlug: localizedSlug,
      provider: _normalizeProvider(bucket.provider),
      generatedAt: bucket.generatedAt || article?.publishedAt || article?.createdAt || null,
      isTranslated: true,
    };
  }

  if (!fallbackToBase) return null;

  return {
    requestedLang: desired,
    resolvedLang: base,
    lang: base,
    title: String(article.title || ''),
    summary: String(_pickSummary(article) || ''),
    content: String(article.content || ''),
    slug: localizedSlug,
    canonicalSlug: localizedSlug,
    provider: originalProvider,
    generatedAt: originalGeneratedAt,
    isTranslated: false,
  };
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  mapArticleForLang,
  localizeArticleForLang,
};
