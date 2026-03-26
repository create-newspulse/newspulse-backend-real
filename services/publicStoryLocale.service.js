const { SUPPORTED_LANGS } = require('./mapArticleForLang');

function normalizeLocale(v) {
  const s0 = String(v ?? '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

function getRequestedLocale(req, { defaultLocale = 'en' } = {}) {
  const q = req && req.query && typeof req.query === 'object' ? req.query : {};
  const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {};

  const fromQuery = normalizeLocale(q.lang ?? q.language);
  const fromHeader = normalizeLocale(headers['x-lang'] ?? headers['x-language']);
  const fromReq = normalizeLocale(req && (req.lang ?? req.language));

  return fromQuery || fromHeader || fromReq || defaultLocale;
}

function parseAllowFallback(req) {
  const q = req && req.query && typeof req.query === 'object' ? req.query : {};
  const raw = q.allowFallback ?? q.fallback ?? q.fallbackTo ?? null;
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return 'en';
  const normalized = normalizeLocale(s);
  return normalized === 'en' ? 'en' : null;
}

function stripHtmlToText(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input);
  const noTags = raw
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, ' ')
    .replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _stripHtmlForLangDetect(v) {
  return String(v ?? '').replace(/<[^>]*>/g, ' ');
}

function _countUnicodeMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function inferLocaleFromDocText(docLike) {
  const d = docLike && typeof docLike === 'object' ? docLike : {};
  const summary = _pickSummary(d);
  const text = _stripHtmlForLangDetect(`${d.title || ''} ${summary || ''} ${d.content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function inferLocaleFromTextParts({ title, summary, content } = {}) {
  const text = _stripHtmlForLangDetect(`${title || ''} ${summary || ''} ${content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function isMismatchedLocaleText(desiredLocale, { title, summary, content } = {}) {
  const desired = normalizeLocale(desiredLocale);
  if (!desired) return false;

  const inferred = inferLocaleFromTextParts({ title, summary, content });
  // Only treat it as mismatched when we can strongly infer a supported
  // locale that is NOT the desired locale.
  return Boolean(inferred && inferred !== desired);
}

function hasFullTranslationBucket(bucket) {
  const b = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
  const content = typeof b.content === 'string' ? b.content.trim() : '';
  return Boolean(title && summary && content);
}

function getDocBaseLocale(docLike) {
  const d = docLike && typeof docLike === 'object' ? docLike : {};
  const declared = (
    normalizeLocale(d.originalLang) ||
    normalizeLocale(d.lang) ||
    normalizeLocale(d.language) ||
    null
  );

  // Safety net: if a fresh publish was mislabeled as en (or missing lang),
  // infer from Unicode ranges to avoid Gujarati leaking on English routes.
  if (declared === 'en' || declared === null) {
    const inferred = inferLocaleFromDocText(d);
    if (inferred) return inferred;
  }

  return declared;
}

function getStoryGroupId(docLike) {
  const d = docLike && typeof docLike === 'object' ? docLike : {};
  const g0 = String(d.translationGroupId || '').trim();
  if (g0) return g0;
  const k0 = String(d.translationKey || '').trim();
  if (k0) return k0;
  const id0 = d._id ? String(d._id) : '';
  return id0 || null;
}

function _pickSummary(docLike) {
  if (docLike && typeof docLike.description === 'string') return docLike.description;
  if (docLike && typeof docLike.summary === 'string') return docLike.summary;
  return '';
}

function _extractLocaleVariantFromDoc(docLike, locale) {
  const desired = normalizeLocale(locale);
  if (!desired || !docLike || typeof docLike !== 'object') return null;

  // Prefer explicit per-locale i18n buckets when present.
  const i18n = docLike.i18n && typeof docLike.i18n === 'object' && !Array.isArray(docLike.i18n) ? docLike.i18n : null;
  if (i18n) {
    const title = typeof i18n?.title?.[desired] === 'string' ? i18n.title[desired] : '';
    const summary = typeof i18n?.summary?.[desired] === 'string' ? i18n.summary[desired] : '';
    const content = typeof i18n?.content?.[desired] === 'string' ? i18n.content[desired] : '';
    if (String(title || '').trim() && String(summary || '').trim() && String(content || '').trim()) {
      if (isMismatchedLocaleText(desired, { title, summary, content })) return null;
      return { locale: desired, title, summary, content, source: 'i18n' };
    }
  }

  const base = getDocBaseLocale(docLike);
  if (base && base === desired) {
    const title = typeof docLike.title === 'string' ? docLike.title : '';
    const summary = _pickSummary(docLike);
    const content = typeof docLike.content === 'string' ? docLike.content : '';
    if (!String(title || '').trim() || !String(summary || '').trim() || !String(content || '').trim()) return null;
    return { locale: desired, title, summary, content, source: 'original' };
  }

  const status = docLike?.translationStatus?.[desired] ?? null;
  const bucket = docLike?.translations?.[desired];
  // Backward compatibility: some legacy docs have full buckets but missing status.
  // Treat null as eligible ONLY when the bucket is complete.
  if (status !== 'ready' && status !== null) return null;
  if (!hasFullTranslationBucket(bucket)) return null;

  if (isMismatchedLocaleText(desired, {
    title: bucket?.title,
    summary: bucket?.summary,
    content: bucket?.content,
  })) {
    return null;
  }

  return {
    locale: desired,
    title: String(bucket.title || ''),
    summary: String(bucket.summary || ''),
    content: String(bucket.content || ''),
    source: status === 'ready' ? 'translation' : 'translation_legacy',
  };
}

function buildLocaleReadiness(docLike) {
  const out = { enReady: false, hiReady: false, guReady: false };
  for (const l of ['en', 'hi', 'gu']) {
    const v = _extractLocaleVariantFromDoc(docLike, l);
    out[`${l}Ready`] = Boolean(v);
  }
  return out;
}

function localizeDocStrict(docLike, requestedLocale, options = {}) {
  const desired = normalizeLocale(requestedLocale) || 'en';
  const fallbackTo = options.fallbackTo === 'en' ? 'en' : null;
  const mode = options.mode === 'detail' ? 'detail' : 'list';
  const logger = options.logger || null;
  const logContext = options.logContext || {};

  const baseObj = docLike && typeof docLike === 'object' && !Array.isArray(docLike) ? { ...docLike } : {};

  const storyGroupId = getStoryGroupId(docLike);
  const readiness = buildLocaleReadiness(docLike);

  const desiredVariant = _extractLocaleVariantFromDoc(docLike, desired);
  let selectedLocale = desiredVariant ? desired : null;
  let variant = desiredVariant;
  let fallbackReason = null;

  if (!variant && fallbackTo === 'en') {
    const enVariant = _extractLocaleVariantFromDoc(docLike, 'en');
    if (enVariant) {
      selectedLocale = 'en';
      variant = enVariant;
      fallbackReason = `missing_${desired}_variant`;
    }
  }

  if (!variant) {
    try {
      logger?.info?.('[public][locale] excluded or not found', {
        storyGroupId,
        requestedLocale: desired,
        readiness,
        ...logContext,
      });
    } catch (_) {}
    return null;
  }

  const titleText = mode === 'list' ? stripHtmlToText(variant.title) : variant.title;
  const summaryText = mode === 'list' ? stripHtmlToText(variant.summary) : variant.summary;

  const slugs = docLike && typeof docLike.slugs === 'object' && !Array.isArray(docLike.slugs) ? docLike.slugs : null;
  const slug = (slugs && typeof slugs[selectedLocale] === 'string' && slugs[selectedLocale].trim())
    ? slugs[selectedLocale].trim()
    : (typeof docLike.slug === 'string' ? docLike.slug : null);

  const shared = {
    storyGroupId,
    requestedLocale: desired,
    selectedLocale,
    selectedVariant: variant.source,
    ...(fallbackReason ? { fallbackReason } : {}),

    // Backward compatibility
    requestedLang: desired,
    resolvedLang: selectedLocale,
    isTranslated: variant.source !== 'original',

    // Keep canonical identifiers & safe metadata when present.
    _id: baseObj._id ?? null,
    translationKey: baseObj.translationKey ?? null,
    translationGroupId: baseObj.translationGroupId ?? null,
    originalLang: baseObj.originalLang ?? null,

    status: typeof baseObj.status === 'string' ? baseObj.status : 'published',
    category: baseObj.category ?? null,
    coverImage: baseObj.coverImage ?? null,
    coverImageUrl: baseObj.coverImageUrl ?? null,
    imageUrl: baseObj.imageUrl ?? null,
    imageAlt: baseObj.imageAlt ?? null,
    imageCaption: baseObj.imageCaption ?? null,

    publishAt: baseObj.publishedAt ?? baseObj.publishAt ?? null,
    publishedAt: baseObj.publishedAt ?? null,
    tags: Array.isArray(baseObj.tags) ? baseObj.tags : [],
    author: baseObj.author ?? null,
    location: baseObj.location ?? null,
    createdAt: baseObj.createdAt ?? null,
    updatedAt: baseObj.updatedAt ?? null,
    slug,
    slugs: slugs || null,
  };

  // Add i18n maps when possible (single-doc view: base + cached translations)
  const titleByLang = { en: null, hi: null, gu: null };
  const summaryByLang = { en: null, hi: null, gu: null };
  const contentByLang = { en: null, hi: null, gu: null };
  for (const l of ['en', 'hi', 'gu']) {
    const v = _extractLocaleVariantFromDoc(docLike, l);
    if (v) {
      titleByLang[l] = String(v.title || '');
      summaryByLang[l] = String(v.summary || '');
      contentByLang[l] = String(v.content || '');
    }
  }

  const out = {
    ...baseObj,
    ...shared,
    ...readiness,

    // Backward-compatible flattened fields
    title: titleText,
    description: summaryText,
    summary: summaryText,
    content: variant.content,
    lang: selectedLocale,
    language: selectedLocale,

    // New structured fields
    titleByLang,
    summaryByLang,
    contentByLang,
  };

  // Never leak translation internals to the public responses.
  try { delete out.translations; } catch (_) {}
  try { delete out.translationStatus; } catch (_) {}
  try { delete out.translationError; } catch (_) {}
  try { delete out.translationNextRetryAt; } catch (_) {}
  try { delete out.translation; } catch (_) {}

  // Never leak workflow/internal moderation fields to public DTOs.
  try { delete out.workflow; } catch (_) {}
  try { delete out.workflowStage; } catch (_) {}
  try { delete out.workflowStageEnteredAt; } catch (_) {}
  try { delete out.workflowUpdatedAt; } catch (_) {}
  try { delete out.workflowHistory; } catch (_) {}
  try { delete out.internalComments; } catch (_) {}
  try { delete out.requiresFounderApproval; } catch (_) {}
  try { delete out.risk; } catch (_) {}
  try { delete out.riskLabel; } catch (_) {}

  return out;
}

module.exports = {
  normalizeLocale,
  getRequestedLocale,
  parseAllowFallback,
  stripHtmlToText,
  hasFullTranslationBucket,
  getDocBaseLocale,
  getStoryGroupId,
  buildLocaleReadiness,
  localizeDocStrict,
};
