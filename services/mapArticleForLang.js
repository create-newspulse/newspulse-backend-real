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

function _stripHtmlForLangDetect(v) {
  return String(v ?? '').replace(/<[^>]*>/g, ' ');
}

function _countUnicodeMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function inferLangFromDocText(article) {
  const a = article && typeof article === 'object' ? article : {};
  const summary = _pickSummary(a);
  const text = _stripHtmlForLangDetect(`${a.title || ''} ${summary || ''} ${a.content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function inferLangFromTextParts({ title, summary, content } = {}) {
  const text = _stripHtmlForLangDetect(`${title || ''} ${summary || ''} ${content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function isMismatchedLocaleText(desiredLang, { title, summary, content } = {}) {
  const desired = normalizeLang(desiredLang);
  if (!desired) return false;
  const inferred = inferLangFromTextParts({ title, summary, content });
  return Boolean(inferred && inferred !== desired);
}

function _hasFullBucket(bucket) {
  const b = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
  return _isNonEmptyString(b.title) && _isNonEmptyString(b.summary) && _isNonEmptyString(b.content);
}

// Strict mapper for feeds:
// - If desired == original => emit original fields
// - Else emit cached translation ONLY when ready + complete
// - Else null (caller should filter out)
function mapArticleForLang(article, lang) {
  const desired = normalizeLang(lang);
  if (!desired) return null;
  if (!article || typeof article !== 'object') return null;

  let base = normalizeLang(article.originalLang) || normalizeLang(article.lang || article.language) || null;
  if (base === 'en' || base === null) {
    const inferred = inferLangFromDocText(article);
    if (inferred) base = inferred;
  }
  if (!base) return null;

  const originalBucket = article?.translations?.[base];
  const originalProvider = _normalizeProvider(originalBucket?.provider || 'manual');
  const originalGeneratedAt = originalBucket?.generatedAt || article?.publishedAt || article?.createdAt || null;

  if (desired === base) {
    const title = String(article.title || '');
    const summary = String(_pickSummary(article) || '');
    const content = String(article.content || '');
    if (!title.trim() || !summary.trim() || !content.trim()) return null;

    if (isMismatchedLocaleText(desired, { title, summary, content })) return null;

    return {
      lang: desired,
      title,
      summary,
      content,
      provider: originalProvider,
      generatedAt: originalGeneratedAt,
      isTranslated: false,
      resolvedLang: base,
    };
  }

  const status = article?.translationStatus?.[desired] || null;
  const bucket = article?.translations?.[desired];
  if (status !== 'ready' || !_hasFullBucket(bucket)) return null;

  if (isMismatchedLocaleText(desired, {
    title: bucket?.title,
    summary: bucket?.summary,
    content: bucket?.content,
  })) {
    return null;
  }

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

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  mapArticleForLang,
};
