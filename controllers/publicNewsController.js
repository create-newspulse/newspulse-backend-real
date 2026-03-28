const mongoose = require('mongoose');

const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { safeTranslateText, normalizeLang } = require('../services/translate/safeTranslate');
const { ensureOnDemandNewsTranslation, hasFullTranslation } = require('../services/newsOnDemandTranslation.service');
const { translateHtmlStrict, detectLangFromContent } = require('../services/articleTranslation.service');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');
const { buildPubliclyVisiblePublicArticleFilter } = require('../services/publicArticleVisibility.service');
const { getSlugCandidates, safeDecodeURIComponent, canonicalizeSlug, slugifyUnicode } = require('../lib/slug');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function isDbReadyOrTest() {
  return (mongoose.connection && mongoose.connection.readyState === 1) || String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

function normalizeSlugOrId(v) {
  return String(v || '').trim();
}

function isObjectIdLike(v) {
  return /^[0-9a-f]{24}$/i.test(String(v || '').trim());
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCategorySlug(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeTopicSlug(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? s : null;
}

function normalizeLocationPart(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function parseTruthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function isAutoTranslateOnReadEnabled() {
  const s = String(process.env.ENABLE_AUTO_TRANSLATE_ON_READ ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function normalizeLanguage(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  // Native script hints
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
}

function getRequestedLang(req) {
  // Canonical param is `lang`, but accept `language` for backward compatibility.
  return (
    normalizeLanguage(req.query.lang) ||
    normalizeLanguage(req.query.language) ||
    normalizeLanguage(req.headers['x-lang']) ||
    normalizeLanguage(req.headers['x-language']) ||
    normalizeLanguage(req.lang) ||
    null
  );
}

function applyLangFilter(filter, lang) {
  if (!lang) return;
  const lower = String(lang).trim().toLowerCase();
  const upper = lower.toUpperCase();
  if (lang === 'gu') {
    // Safety net for historical/mislabeled data: include clearly-Gujarati content even if lang fields are wrong.
    // Use a small threshold (12 Gujarati-block chars) to avoid flipping for a single borrowed word.
    const likelyGujaratiRx = new RegExp('(?:.*[\\u0A80-\\u0AFF]){12}');
    const likelyGujaratiTextClause = {
      $or: [
        { title: { $regex: likelyGujaratiRx } },
        { description: { $regex: likelyGujaratiRx } },
        { summary: { $regex: likelyGujaratiRx } },
        { content: { $regex: likelyGujaratiRx } },
      ],
    };

    filter.$and.push({
      $or: [
        { lang: { $in: [lower, upper] } },
        { language: { $in: [lower, upper] } },
        // Default-to-gu ONLY when neither field provides a language.
        {
          $and: [
            { $or: [{ lang: null }, { lang: { $exists: false } }] },
            { $or: [{ language: null }, { language: { $exists: false } }] },
          ],
        },
        // If a doc was saved as lang=en/hi but the body is clearly Gujarati, include it in Gujarati feed.
        {
          $and: [
            { $or: [{ lang: { $in: ['en', 'EN', 'hi', 'HI'] } }, { language: { $in: ['en', 'EN', 'hi', 'HI'] } }] },
            likelyGujaratiTextClause,
          ],
        },
      ],
    });
  } else {
    filter.$and.push({ $or: [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }] });
  }
}

function buildOriginalLangMatch(lang) {
  const lower = String(lang).trim().toLowerCase();
  const upper = lower.toUpperCase();
  return {
    $or: [
      { originalLang: { $in: [lower, upper] } },
      // Backward compatibility: many older docs only have lang/language.
      { $and: [
        { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
        { $or: [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }] },
      ] },
    ],
  };
}

function buildReadyTranslationMatch(lang) {
  const desired = String(lang).trim().toLowerCase();
  // Feed must never include placeholder/pending translations.
  // Require: translationStatus.<lang> === 'ready' and full bucket fields exist.
  return {
    $and: [
      { [`translationStatus.${desired}`]: 'ready' },
      { [`translations.${desired}.title`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.summary`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.content`]: { $exists: true, $ne: '' } },
    ],
  };
}

function isPlainTextBody(content) {
  const s = String(content || '');
  if (!s.trim()) return true;
  return !/[<][^>]+[>]/.test(s);
}

async function translateNewsDocFields(doc, targetLang, { contextPrefix = 'news', strict = false } = {}) {
  const requested = normalizeLang(targetLang);
  if (!requested) return { doc, changed: false, flags: { bodyTranslated: false } };

  const source = detectLangFromContent(doc.content) || normalizeLang(doc.lang || doc.language) || 'gu';
  if (source === requested) return { doc, changed: false, flags: { bodyTranslated: false } };

  let changed = false;
  const warnings = [];

  const titleRes = await safeTranslateText({
    text: doc.title || '',
    sourceLang: source,
    targetLang: requested,
    context: `${contextPrefix}:title`,
    strict,
  });
  if (!titleRes.usedFallback && titleRes.text) {
    doc.title = titleRes.text;
    changed = true;
  } else if (titleRes.warnings?.length) {
    warnings.push(...titleRes.warnings);
  }

  const descRes = await safeTranslateText({
    text: doc.description || doc.summary || '',
    sourceLang: source,
    targetLang: requested,
    context: `${contextPrefix}:summary`,
    strict,
  });
  if (!descRes.usedFallback && descRes.text) {
    doc.description = descRes.text;
    changed = true;
  } else if (descRes.warnings?.length) {
    warnings.push(...descRes.warnings);
  }

  let bodyTranslated = false;
  if (typeof doc.content === 'string' && doc.content.trim()) {
    if (isPlainTextBody(doc.content)) {
      const bodyRes = await safeTranslateText({
        text: doc.content,
        sourceLang: source,
        targetLang: requested,
        context: `${contextPrefix}:body`,
        strict: false,
      });
      if (!bodyRes.usedFallback && bodyRes.text) {
        doc.content = bodyRes.text;
        changed = true;
        bodyTranslated = true;
      } else {
        bodyTranslated = false;
        warnings.push('body_not_translated');
      }
    } else {
      // Rich text (HTML): translate in HTML mode with chunking.
      const htmlRes = await translateHtmlStrict({ html: doc.content, sourceLang: source, targetLang: requested, maxChunkChars: 4000 });
      if (htmlRes && htmlRes.ok && typeof htmlRes.html === 'string' && htmlRes.html.trim()) {
        doc.content = htmlRes.html;
        changed = true;
        bodyTranslated = true;
      } else {
        bodyTranslated = false;
        warnings.push('body_not_translated');
        try {
          console.warn('[i18n][news] html body translation failed', {
            slug: String(doc.slug || ''),
            from: source,
            to: requested,
            error: htmlRes && htmlRes.ok === false ? htmlRes.error : 'empty_output',
          });
        } catch (_) {}
      }
    }
  }

  if (changed) {
    doc.lang = requested;
    doc.language = requested;
  }

  if (warnings.length) {
    doc.translation = {
      requestedLang: requested,
      sourceLang: source,
      bodyTranslated,
      warnings: Array.from(new Set(warnings)).slice(0, 8),
    };
  }

  return { doc, changed, flags: { bodyTranslated } };
}

// POST /api/public/news/:id/translate
// Stores translations in News.translations[lang] so switching is instant.
async function translatePublicNews(req, res) {
  try {
    const target = normalizeLanguage(req.body && req.body.lang);
    if (!target) return res.status(400).json({ success: false });

    if (!isDbReadyOrTest()) {
      return res.status(503).json({ success: false, message: 'Database unavailable' });
    }

    const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'Missing GOOGLE_TRANSLATE_API_KEY' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });

    const doc = await News.findById(id);
    if (!doc || String(doc.status || '').toLowerCase() !== 'published') {
      return res.status(404).json({ success: false });
    }

    if (doc.translations && doc.translations[target] && String(doc.translations[target].content || '').trim()) {
      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      return res.status(200).json({ success: true, data: { ...obj, activeLang: target } });
    }

    const title = String(doc.title || '');
    const summary = String(doc.summary || doc.description || '');
    const content = String(doc.content || doc.body || '');

    // Translate + cache full (title+summary+content). Never silently skip body.
    // NOTE: we translate from detected source (or stored lang) and use HTML mode for HTML bodies.
    const obj0 = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    const localized = await ensureOnDemandNewsTranslation({
      doc: { ...obj0, title, description: summary, content },
      requestedLang: target,
      logger: console,
      lockOwner: true,
      now: new Date(),
    });

    doc.translations = doc.translations || {};
    doc.translations[target] = doc.translations[target] || { title: '', summary: '', content: '', generatedAt: null };
    const prevProvider = doc.translations[target] && doc.translations[target].provider ? doc.translations[target].provider : undefined;
    const prevGeneratedAt = doc.translations[target] && doc.translations[target].generatedAt ? doc.translations[target].generatedAt : undefined;

    const newBucket = {
      title: String(localized?.out?.title || '').trim(),
      summary: String(localized?.out?.description || '').trim(),
      content: String(localized?.out?.content || '').trim(),
    };

    // If translation failed (strict fallback), keep previous values (or original) but log.
    const resolvedToTarget = Boolean(localized && localized.resolvedLang === target && localized.translationPending === false);
    if (resolvedToTarget && newBucket.title && newBucket.summary && newBucket.content) {
      doc.translations[target] = {
        ...newBucket,
        provider: 'google',
        generatedAt: new Date(),
      };
    } else {
      try {
        console.warn('[i18n][news] translate endpoint did not produce full translation', {
          id,
          slug: String(doc.slug || ''),
          target,
          resolvedLang: localized?.resolvedLang,
          translationPending: !!localized?.translationPending,
        });
      } catch (_) {}
      doc.translations[target] = {
        title: (doc.translations[target] && doc.translations[target].title) ? doc.translations[target].title : title,
        summary: (doc.translations[target] && doc.translations[target].summary) ? doc.translations[target].summary : summary,
        content: (doc.translations[target] && doc.translations[target].content) ? doc.translations[target].content : content,
      };

      // Never persist provider: null (schema enum rejects it). Preserve existing values only when set.
      if (prevProvider) doc.translations[target].provider = prevProvider;
      if (prevGeneratedAt) doc.translations[target].generatedAt = prevGeneratedAt;
    }

    // Keep per-language slugs in sync with stored translations.
    doc.slugs = doc.slugs || {};
    const titleForSlug = String(doc.translations[target].title || '').trim();
    if (titleForSlug) {
      doc.slugs[target] = slugifyUnicode(titleForSlug);
    }

    try {
      await doc.save();
      try {
        console.info('[i18n][news] saved translation via public translate endpoint', { id, slug: String(doc.slug || ''), target });
      } catch (_) {}
    } catch (e) {
      try {
        console.warn('[i18n][news] failed saving translation via public translate endpoint', {
          id,
          slug: String(doc.slug || ''),
          target,
          message: e?.message || String(e),
        });
      } catch (_) {}
      throw e;
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.status(200).json({ success: true, data: { ...obj, activeLang: target } });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'translate failed' });
  }
}

function buildPublicPublishedFilter({ category, q, founderOnly, type }) {
  const now = new Date();
  const normalizedCategory = category ? normalizeCategorySlug(category) : null;

  const filter = {
    $and: [
      // Public list must only include published stories.
      { status: { $regex: '^published$', $options: 'i' } },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: now } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: now } }] },
    ],
  };

  if (normalizedCategory) {
    // Case-safe for older mixed-case data.
    filter.category = new RegExp(`^${escapeRegExp(normalizedCategory)}$`, 'i');
  }

  if (founderOnly) {
    filter.$and.push({
      $or: [
        { isFounder: true },
        { authorRole: { $regex: '^FOUNDER$', $options: 'i' } },
        // Works for both string and array-valued fields.
        { authorTag: { $regex: 'Founder', $options: 'i' } },
      ],
    });
  }

  if (type === 'video') {
    filter.$and.push({
      $or: [
        { contentType: { $regex: '^video$', $options: 'i' } },
        { mediaType: { $regex: '^video$', $options: 'i' } },
        { postType: { $regex: '^video$', $options: 'i' } },
        { videoUrl: { $exists: true, $ne: '' } },
      ],
    });
  }

  if (q) {
    const safe = escapeRegExp(q);
    // Regex search is simple but can be slow on large collections; keep it bounded.
    const rx = new RegExp(safe, 'i');
    filter.$and.push({
      $or: [
        { title: rx },
        { summary: rx },
        { description: rx },
        { content: rx },
      ],
    });
  }

  return filter;
}

const PUBLIC_SELECT = [
  'title',
  'description',
  'content',
  'slug',
  'slugs',
  'tags',
  'category',
  'topic',
  'location',
  'lang',
  'language',
  'originalLang',
  'translationKey',
  'translationGroupId',
  // Image fields (legacy + new)
  'imageUrl',
  'imageURL',
  'coverImageUrl',
  'coverImage',
  // Optional/legacy fields that may exist in older docs
  'image',
  'thumbnail',
  'images',
  'imageAlt',
  'imageCaption',
  'publishedAt',
  'date',
  'createdAt',
  'updatedAt',
].join(' ');

// Detail endpoints need `translations` for caching + instant language switching.
const PUBLIC_DETAIL_SELECT = `${PUBLIC_SELECT} originalLang translations translationStatus translationError translationNextRetryAt`;

// Feed needs translationStatus to filter and translations to localize.
const PUBLIC_FEED_SELECT = `${PUBLIC_SELECT} originalLang translations translationStatus`;

const PUBLIC_ARTICLE_DETAIL_SELECT = [
  'title',
  'summary',
  'content',
  'slug',
  'slugs',
  'tags',
  'category',
  'language',
  'originalLang',
  'translationKey',
  'translationGroupId',
  'sourceNewsId',
  'translations',
  'translationStatus',
  'translationError',
  'translationNextRetryAt',
  'coverImageUrl',
  'coverImage',
  'imageUrl',
  'imageURL',
  'publishedAt',
  'createdAt',
  'updatedAt',
  'geo',
  'state',
  'district',
  'city',
].join(' ');

function _mapPublicArticleToNewsLikeShape(articleDoc) {
  const out = { ...(articleDoc || {}) };
  out.description = out.description || out.summary || '';
  out.summary = out.summary || out.description || '';
  out.lang = out.lang || out.language || out.originalLang || 'en';
  out.language = out.language || out.lang || 'en';
  return out;
}

function _normalizeOptionalString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function _extractImageUrlFromAny(v) {
  if (!v) return null;
  if (typeof v === 'string') return _normalizeOptionalString(v);
  if (typeof v === 'object' && !Array.isArray(v)) {
    // Common shapes: { url }, { src }, { secure_url }
    return _normalizeOptionalString(v.url || v.src || v.secure_url || null);
  }
  return null;
}

function _extractFirstImgSrcFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return null;

  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const raw = (m && (m[1] || m[2] || m[3])) ? String(m[1] || m[2] || m[3]) : '';
  const url = _normalizeOptionalString(raw);
  if (!url) return null;
  if (url.length > 2048) return null;

  const lower = url.toLowerCase();
  if (lower.startsWith('javascript:')) return null;
  if (lower.startsWith('data:') && !lower.startsWith('data:image/')) return null;

  return url;
}

function withCoverImageUrl(obj) {
  const out = { ...(obj || {}) };

  // Normalize imageUrl with the requested priority, plus legacy fields.
  // Priority: imageUrl || coverImage || image || thumbnail || images[0] || null
  const candidates = [];
  candidates.push(_extractImageUrlFromAny(out.imageUrl));
  candidates.push(_extractImageUrlFromAny(out.coverImageUrl));
  candidates.push(_extractImageUrlFromAny(out.coverImage));
  candidates.push(_extractImageUrlFromAny(out.imageURL));
  candidates.push(_extractImageUrlFromAny(out.image));
  candidates.push(_extractImageUrlFromAny(out.thumbnail));

  if (Array.isArray(out.images) && out.images.length) {
    candidates.push(_extractImageUrlFromAny(out.images[0]));
  }

  let imageUrl = candidates.find(Boolean) || null;

  // Optional fallback: extract from body HTML when no explicit image exists.
  if (!imageUrl) {
    imageUrl = _extractFirstImgSrcFromHtml(out.content) || null;
  }

  out.imageUrl = imageUrl;

  // Keep backward-compatible coverImageUrl populated.
  const coverFromObj = (out.coverImage && typeof out.coverImage === 'object') ? _normalizeOptionalString(out.coverImage.url) : null;
  out.coverImageUrl = _normalizeOptionalString(out.coverImageUrl) || _normalizeOptionalString(out.imageURL) || coverFromObj || out.imageUrl || null;

  // Normalize optional alt/caption fields (pass-through if present).
  const alt =
    _normalizeOptionalString(out.imageAlt) ||
    (out.coverImage && typeof out.coverImage === 'object' ? _normalizeOptionalString(out.coverImage.alt) : null) ||
    (out.image && typeof out.image === 'object' ? _normalizeOptionalString(out.image.alt) : null) ||
    null;

  const caption =
    _normalizeOptionalString(out.imageCaption) ||
    (out.coverImage && typeof out.coverImage === 'object' ? _normalizeOptionalString(out.coverImage.caption) : null) ||
    (out.image && typeof out.image === 'object' ? _normalizeOptionalString(out.image.caption) : null) ||
    null;

  out.imageAlt = alt;
  out.imageCaption = caption;

  out.lang = out.lang || out.language || 'gu';
  out.language = out.language || out.lang || 'gu';
  return out;
}

function pickCanonicalSlug(doc, lang) {
  const target = normalizeLang(lang) || normalizeLang(doc?.lang || doc?.language) || 'en';
  const slugs = doc && doc.slugs && typeof doc.slugs === 'object' ? doc.slugs : null;
  return (
    (slugs && slugs[target]) ||
    doc?.slug ||
    (slugs && (slugs.en || slugs.hi || slugs.gu)) ||
    null
  );
}

function attachLocalizationFields(doc, requestedLang) {
  doc.canonicalSlug = pickCanonicalSlug(doc, requestedLang);
  doc.localizedSlug = doc.canonicalSlug;
  doc.localizedTitle = doc.title || '';
  doc.localizedContent = doc.content || '';
  return doc;
}

function buildPendingTranslationResponse(doc, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const source =
    normalizeLang(doc?.originalLang) ||
    detectLangFromContent(doc?.content) ||
    normalizeLang(doc?.lang || doc?.language) ||
    'en';

  return {
    status: 'pending',
    requestedLang: desired || null,
    resolvedLang: source,
    canonicalSlug: pickCanonicalSlug(doc, desired || source),
    slug: doc?.slug || null,
    _id: doc?._id || null,
    translationKey: doc?.translationKey || doc?.translationGroupId || null,
  };
}

function detectStrongScriptLang(textOrHtml) {
  const s = String(textOrHtml || '').replace(/<[^>]*>/g, ' ');
  if (!s.trim()) return null;

  const gu = (s.match(/[\u0A80-\u0AFF]/g) || []).length;
  const hi = (s.match(/[\u0900-\u097F]/g) || []).length;
  const MIN = 12;

  if (gu >= MIN && gu > hi) return 'gu';
  if (hi >= MIN && hi > gu) return 'hi';
  return null;
}

function _resolveBaseLang(doc) {
  const original = normalizeLang(doc?.originalLang);
  if (original) return original;

  const stored = normalizeLang(doc?.lang || doc?.language);
  if (stored && stored !== 'en') return stored;

  // If stored is missing or 'en', allow strong script-based detection to correct obvious mislabels.
  const strong = detectStrongScriptLang(doc?.content);
  if (strong && strong !== 'en') return strong;

  return stored || detectLangFromContent(doc?.content) || 'en';
}

function _applyCachedTranslationInPlace(doc, desired, options = {}) {
  const allowMissingStatus = options && options.allowMissingStatus === true;
  const t = doc?.translations?.[desired];
  if (!hasFullTranslation(t)) return false;
  const rawStatus = doc?.translationStatus?.[desired];
  const status = rawStatus === null || rawStatus === undefined ? null : String(rawStatus).trim().toLowerCase();
  if (status !== 'ready' && !(allowMissingStatus && !status)) return false;

  doc.title = t.title;
  doc.description = t.summary;
  doc.summary = t.summary;
  doc.content = t.content;
  doc.requestedLang = desired;
  doc.resolvedLang = desired;
  doc.isTranslated = true;
  doc.translationProvider = (t.provider === null || t.provider === undefined || String(t.provider).trim() === '')
    ? 'google'
    : String(t.provider).trim().toLowerCase();
  doc.translationGeneratedAt = t.generatedAt || null;
  doc.lang = desired;
  doc.language = desired;
  return true;
}

function _setBaseLocalizationInPlace(doc, baseLang, requestedLang) {
  const base = normalizeLang(baseLang) || _resolveBaseLang(doc);
  doc.requestedLang = requestedLang || null;
  doc.resolvedLang = base;
  doc.isTranslated = false;
  doc.lang = base;
  doc.language = base;
  doc.summary = doc.description || '';
  return base;
}

function _applyBestAvailableCachedLocalizationInPlace(doc, requestedLang) {
  const requested = normalizeLang(requestedLang);
  const base = _resolveBaseLang(doc);

  const ordered = [requested, 'en', 'hi', 'gu', base].filter(Boolean);
  const seen = new Set();
  for (const lang of ordered) {
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);

    if (lang === base) {
      return { resolvedLang: _setBaseLocalizationInPlace(doc, base, requested), translated: false };
    }

    const ok = _applyCachedTranslationInPlace(doc, lang);
    if (ok) {
      // Preserve requestedLang even if we fell back to another cached language.
      doc.requestedLang = requested || null;
      doc.resolvedLang = lang;
      return { resolvedLang: lang, translated: true };
    }
  }

  return { resolvedLang: _setBaseLocalizationInPlace(doc, base, requested), translated: false };
}

function _applyRequestedCachedLocalizationOrBaseInPlace(doc, requestedLang) {
  const requested = normalizeLang(requestedLang);
  const base = _resolveBaseLang(doc);

  if (!requested || requested === base) {
    return { resolvedLang: _setBaseLocalizationInPlace(doc, base, requested), translated: false };
  }

  const localized = _applyCachedTranslationInPlace(doc, requested, { allowMissingStatus: true });
  if (localized) {
    doc.requestedLang = requested;
    doc.resolvedLang = requested;
    return { resolvedLang: requested, translated: true };
  }

  return { resolvedLang: _setBaseLocalizationInPlace(doc, base, requested), translated: false };
}

async function tryAcquireNewsTranslationLock({ id, lang, now = new Date() }) {
  const desired = normalizeLang(lang);
  if (!desired || !id) return false;

  const nowDt = now instanceof Date ? now : new Date(now);

  try {
    const lockRes = await News.updateOne(
      {
        _id: id,
        $and: [
          { [`translationStatus.${desired}`]: { $ne: 'pending' } },
          {
            $or: [
              { [`translationStatus.${desired}`]: { $ne: 'failed' } },
              { [`translationNextRetryAt.${desired}`]: { $exists: false } },
              { [`translationNextRetryAt.${desired}`]: null },
              { [`translationNextRetryAt.${desired}`]: { $lte: nowDt } },
            ],
          },
        ],
      },
      {
        $set: {
          [`translationStatus.${desired}`]: 'pending',
          [`translationError.${desired}`]: null,
          [`translationNextRetryAt.${desired}`]: null,
        },
      }
    );

    const modified = typeof lockRes?.modifiedCount === 'number'
      ? lockRes.modifiedCount
      : (typeof lockRes?.nModified === 'number' ? lockRes.nModified : 0);
    return modified === 1;
  } catch (_) {
    return false;
  }
}

// GET /api/public/news?category=&type=video&founderOnly=true&limit=30&page=1
async function listPublicNews(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '30', 10), 1), 100);

    const category = normalizeCategorySlug(req.query.category);
    const topic = normalizeTopicSlug(req.query.topic);
    const state = normalizeLocationPart(req.query.state || req.query.locationState);
    const founderOnly = parseTruthy(req.query.founderOnly);
    const type = String(req.query.type || '').trim().toLowerCase();

    // Default language for public story feed is Gujarati (backward compatible).
    const requestedLang = getRequestedLang(req) || 'gu';
    const desired = normalizeLang(requestedLang) || 'gu';

    let q = String(req.query.q || '').trim();
    // Keep keyword search safe and bounded
    if (q.length > 80) q = q.slice(0, 80);

    if (!isDbReady()) {
      return res.status(200).json({ items: [], page, limit, total: 0, totalPages: 1 });
    }

    const filter = buildPublicPublishedFilter({
      category: category || undefined,
      q: q || undefined,
      founderOnly,
      type,
    });
    if (topic) filter.$and.push({ topic: new RegExp(`^${escapeRegExp(topic)}$`, 'i') });
    if (state) filter.$and.push({ 'location.state': new RegExp(`^${escapeRegExp(state)}$`, 'i') });

    // Feed rules:
    // - Gujarati feed shows originals immediately (legacy behavior).
    // - Hindi/English feeds only show items when either:
    //   - the original is authored in that language, OR
    //   - the cached translation bucket is fully ready (no placeholders).
    if (desired === 'hi' || desired === 'en') {
      filter.$and.push({
        $or: [
          buildOriginalLangMatch(desired),
          buildReadyTranslationMatch(desired),
        ],
      });
    }

    const skip = (page - 1) * limit;
    const sort = { publishedAt: -1, createdAt: -1 };

    const [itemsRaw, total] = await Promise.all([
      News.find(filter).select(PUBLIC_FEED_SELECT).sort(sort).skip(skip).limit(limit).lean(),
      News.countDocuments(filter),
    ]);

    let items = (itemsRaw || []).map(withCoverImageUrl);

    // Localize strictly from cached buckets.
    items = items
      .map((it) => {
        const out = { ...it };
        const localized = _applyRequestedCachedLocalizationOrBaseInPlace(out, desired);
        if (!localized) return null;
        attachLocalizationFields(out, desired);
        return out;
      })
      .filter(Boolean);

    // Keep response payload stable (don’t emit translation cache).
    for (const it of items) {
      try { delete it.translations; } catch (_) {}
      try { delete it.translationStatus; } catch (_) {}
      try { delete it.translationError; } catch (_) {}
      try { delete it.translationNextRetryAt; } catch (_) {}
    }
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({ items, page, limit, total, totalPages });
  } catch (e) {
    return res.status(500).json({ items: [], page: 1, limit: 30, total: 0, totalPages: 1, message: e?.message || String(e) });
  }
}

// GET /api/public/news/translation?translationKey=...&lang=...
async function getPublicNewsByTranslationKey(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const translationKey = String(req.query.translationKey || '').trim();
    if (!translationKey) return res.status(400).json({ message: 'Missing translationKey' });

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    const requestedLang = getRequestedLang(req);
    const base = buildPublicPublishedFilter({});
    base.$and.push({ $or: [{ translationKey }, { translationGroupId: translationKey }] });

    const filter = { ...base, $and: [...(base.$and || [])] };
    if (requestedLang) applyLangFilter(filter, requestedLang);

    let doc = await News.findOne(filter).select(PUBLIC_SELECT).lean();
    if (!doc && !requestedLang) {
      // Default: try Gujarati if not specified.
      const fallback = { ...base, $and: [...(base.$and || [])] };
      applyLangFilter(fallback, 'gu');
      doc = await News.findOne(fallback).select(PUBLIC_SELECT).lean();
    }

    if (!doc) return res.status(404).json({ message: 'Not found' });

    const out = withCoverImageUrl(doc);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

// GET /api/public/news/translations/:translationGroupId
async function listPublicNewsTranslations(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const translationGroupId = String(req.params.translationGroupId || '').trim();
    if (!translationGroupId) return res.status(200).json([]);

    if (!isDbReady()) {
      return res.status(200).json([]);
    }

    const filter = buildPublicPublishedFilter({});
    filter.$and.push({ translationGroupId });

    const itemsRaw = await News.find(filter)
      .select(PUBLIC_SELECT)
      .sort({ language: 1, publishedAt: -1, createdAt: -1 })
      .lean();

    const items = (itemsRaw || []).map(withCoverImageUrl);
    return res.status(200).json(items);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

// GET /api/public/news/:slugOrId
async function getPublicNewsBySlugOrId(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const debugEnabled = parseTruthy(process.env.DEBUG_PUBLIC_NEWS_DETAIL) || parseTruthy(process.env.PUBLIC_NEWS_DETAIL_DEBUG);
    const debugOnly = String(process.env.DEBUG_PUBLIC_NEWS_DETAIL_ID || '').trim();

    const slugOrIdRaw = normalizeSlugOrId(req.params.slugOrId);
    if (!slugOrIdRaw) {
      return res.status(404).json({ message: 'Not found' });
    }

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    const base = buildPublicPublishedFilter({});
    let doc = null;
    let docSource = 'news';

    // Prefer requested language doc when available.
    const requestedLang = getRequestedLang(req);
    const shouldDebug = debugEnabled && (!debugOnly || debugOnly === slugOrIdRaw);
    const debug = (event, payload) => {
      if (!shouldDebug) return;
      try {
        console.log('[public-news][detail]', event, {
          slugOrId: slugOrIdRaw,
          requestedLang: requestedLang || null,
          ...(payload || {}),
        });
      } catch (_) {}
    };

    const lookup = { ...base, $and: [...(base.$and || [])] };
    if (isObjectIdLike(slugOrIdRaw)) {
      lookup._id = slugOrIdRaw;
    } else {
      const slugCandidates = getSlugCandidates(slugOrIdRaw);
      const slugFilter = slugCandidates.length === 1 ? slugCandidates[0] : { $in: slugCandidates };
      lookup.$and.push({
        $or: [
          { slug: slugFilter },
          { 'slugs.en': slugFilter },
          { 'slugs.hi': slugFilter },
          { 'slugs.gu': slugFilter },
        ],
      });
    }

    debug('lookup_built', { isObjectIdLike: isObjectIdLike(slugOrIdRaw) });

    if (requestedLang) {
      const byLangFilter = { ...lookup, $and: [...(lookup.$and || [])] };
      applyLangFilter(byLangFilter, requestedLang);
      doc = await News.findOne(byLangFilter).select(PUBLIC_DETAIL_SELECT).lean();
    }

    if (!doc) {
      doc = await News.findOne(lookup).select(PUBLIC_DETAIL_SELECT).lean();
    }

    if (!doc) {
      // Fallback: regional feeds are backed by PublicArticle (_id differs from News).
      // Try resolving PublicArticle by id/slug, then hop back to News via sourceNewsId when possible.
      const paBase = buildPubliclyVisiblePublicArticleFilter({});
      const paLookup = { ...paBase, $and: [...(paBase.$and || [])] };

      if (isObjectIdLike(slugOrIdRaw)) {
        paLookup._id = slugOrIdRaw;
      } else {
        const slugCandidates = getSlugCandidates(slugOrIdRaw);
        const slugFilter = slugCandidates.length === 1 ? slugCandidates[0] : { $in: slugCandidates };
        paLookup.$and.push({
          $or: [
            { slug: slugFilter },
            { 'slugs.en': slugFilter },
            { 'slugs.hi': slugFilter },
            { 'slugs.gu': slugFilter },
          ],
        });
      }

      let paDoc = null;
      if (requestedLang) {
        const paByLang = { ...paLookup, $and: [...(paLookup.$and || [])] };
        applyLangFilter(paByLang, requestedLang);
        paDoc = await PublicArticle.findOne(paByLang).select(PUBLIC_ARTICLE_DETAIL_SELECT).lean();
      }
      if (!paDoc) {
        paDoc = await PublicArticle.findOne(paLookup).select(PUBLIC_ARTICLE_DETAIL_SELECT).lean();
      }

      if (paDoc) {
        debug('resolved_public_article', {
          publicArticleId: String(paDoc?._id || ''),
          sourceNewsId: paDoc?.sourceNewsId ? String(paDoc.sourceNewsId) : null,
          publicArticleLang: String(paDoc?.language || paDoc?.lang || ''),
        });

        if (paDoc.sourceNewsId) {
          const bySource = { ...base, _id: paDoc.sourceNewsId, $and: [...(base.$and || [])] };
          const newsBySource = await News.findOne(bySource).select(PUBLIC_DETAIL_SELECT).lean();
          if (newsBySource) {
            doc = newsBySource;
            docSource = 'news';
          } else {
            doc = _mapPublicArticleToNewsLikeShape(paDoc);
            docSource = 'publicArticle';
          }
        } else {
          doc = _mapPublicArticleToNewsLikeShape(paDoc);
          docSource = 'publicArticle';
        }
      }
    }

    if (!doc) {
      debug('not_found', {});
      return res.status(404).json({ message: 'Not found' });
    }

    debug('resolved_doc', {
      docSource,
      resolvedId: doc?._id ? String(doc._id) : null,
      status: String(doc?.status || ''),
      lang: String(doc?.lang || ''),
      language: String(doc?.language || ''),
      originalLang: String(doc?.originalLang || ''),
      publishedAt: doc?.publishedAt || null,
    });

    let out = withCoverImageUrl(doc);
    const rawForTranslation = { ...out };

    const desired = normalizeLang(requestedLang);
    if (!desired) {
      const base = _resolveBaseLang(out);
      _setBaseLocalizationInPlace(out, base, null);
      try { delete out.translations; } catch (_) {}
      try { delete out.translationStatus; } catch (_) {}
      attachLocalizationFields(out, out.resolvedLang);
      return res.status(200).json(out);
    }

    // 1) Prefer cached translation for requested language.
    // 2) Fall back to other cached languages in order: requested → en → hi → gu → base.
    // 3) Optionally auto-translate requested language on read (dev-only), if enabled.
    const baseLang = _resolveBaseLang(out);
    const cachedRes = _applyRequestedCachedLocalizationOrBaseInPlace(out, desired);

    const shouldAuto = isAutoTranslateOnReadEnabled();
    const needsRequested = desired !== baseLang && cachedRes.resolvedLang !== desired;

    const allowOnDemandTranslate = docSource === 'news';

    if (shouldAuto && needsRequested && allowOnDemandTranslate && isGoogleTranslateConfigured()) {
      const now = new Date();
      const lockOwner = await tryAcquireNewsTranslationLock({ id: out?._id, lang: desired, now });
      const localized = await ensureOnDemandNewsTranslation({
        doc: rawForTranslation,
        requestedLang: desired,
        logger: console,
        lockOwner,
        now,
      });

      if (localized && localized.dbSet && out && out._id) {
        try {
          await News.updateOne({ _id: out._id }, { $set: localized.dbSet }).catch(() => null);
        } catch (_) {}
      }

      if (localized && localized.out && localized.resolvedLang === desired && localized.translationPending === false) {
        out = withCoverImageUrl(localized.out);
        out.requestedLang = desired;
        out.resolvedLang = desired;
        out.isTranslated = true;
        out.summary = out.description || out.summary || '';
      } else {
        // Keep the best cached/base fallback already applied.
        out.requestedLang = desired;
      }
    } else {
      out.requestedLang = desired;
    }

    try { delete out.translations; } catch (_) {}
    try { delete out.translationStatus; } catch (_) {}
    try { delete out.translationError; } catch (_) {}
    try { delete out.translationNextRetryAt; } catch (_) {}
    attachLocalizationFields(out, desired);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

// GET /api/public/news/slug/:slug
// Unicode-safe: tries both decoded and raw slug variants.
async function getPublicNewsBySlug(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    const decodedParam = String(req.params.slug ?? '').trim();
    if (!decodedParam) return res.status(400).json({ message: 'Missing slug' });

    if (!isDbReady()) {
      return res.status(404).json({ message: 'Not found' });
    }

    // Express usually decodes route params. To also try the raw percent-encoded
    // form (which may be stored by older clients), extract it from originalUrl.
    const originalUrl = String(req.originalUrl || req.url || '');
    const rawFromUrl = (() => {
      const m = originalUrl.match(/\/slug\/([^?]+)/);
      return m && m[1] ? String(m[1]).trim() : '';
    })();

    const decoded = String(safeDecodeURIComponent(decodedParam) ?? '').trim();
    const candidates = new Set();
    if (decoded) candidates.add(decoded);
    if (decodedParam) candidates.add(decodedParam);
    if (rawFromUrl) candidates.add(rawFromUrl);

    // Also try canonical/normalized forms for stable lookups.
    const canonRaw = canonicalizeSlug(rawFromUrl || decodedParam);
    if (canonRaw) candidates.add(canonRaw);
    const canonDecoded = decoded ? canonicalizeSlug(decoded) : '';
    if (canonDecoded) candidates.add(canonDecoded);

    for (const c of getSlugCandidates(decodedParam)) candidates.add(c);
    for (const c of getSlugCandidates(rawFromUrl || decodedParam)) candidates.add(c);
    if (decoded) {
      for (const c of getSlugCandidates(decoded)) candidates.add(c);
    }

    const slugCandidates = Array.from(candidates).filter(Boolean);
    const slugFilter = slugCandidates.length <= 1 ? (slugCandidates[0] || decodedParam) : { $in: slugCandidates };

    const slugClause = {
      $or: [
        { slug: slugFilter },
        { 'slugs.en': slugFilter },
        { 'slugs.hi': slugFilter },
        { 'slugs.gu': slugFilter },
      ],
    };

    const base = buildPublicPublishedFilter({});
    const requestedLang = getRequestedLang(req);

    let doc = null;
    if (requestedLang) {
      const byLangFilter = { ...base, $and: [...(base.$and || []), slugClause] };
      applyLangFilter(byLangFilter, requestedLang);
      doc = await News.findOne(byLangFilter).select(PUBLIC_DETAIL_SELECT).lean();
    }

    if (!doc) {
      doc = await News.findOne({ ...base, $and: [...(base.$and || []), slugClause] }).select(PUBLIC_DETAIL_SELECT).lean();
    }

    if (!doc) return res.status(404).json({ message: 'Not found' });

    let out = withCoverImageUrl(doc);
    const rawForTranslation = { ...out };

    const desired = normalizeLang(requestedLang);
    if (!desired) {
      const base = _resolveBaseLang(out);
      _setBaseLocalizationInPlace(out, base, null);
      try { delete out.translations; } catch (_) {}
      try { delete out.translationStatus; } catch (_) {}
      attachLocalizationFields(out, desired);
      return res.status(200).json(out);
    }

    const baseLang = _resolveBaseLang(out);
    const cachedRes = _applyRequestedCachedLocalizationOrBaseInPlace(out, desired);

    const shouldAuto = isAutoTranslateOnReadEnabled();
    const needsRequested = desired !== baseLang && cachedRes.resolvedLang !== desired;

    if (shouldAuto && needsRequested && isGoogleTranslateConfigured()) {
      const now = new Date();
      const lockOwner = await tryAcquireNewsTranslationLock({ id: out?._id, lang: desired, now });
      const localized = await ensureOnDemandNewsTranslation({
        doc: rawForTranslation,
        requestedLang: desired,
        logger: console,
        lockOwner,
        now,
      });

      if (localized && localized.dbSet && out && out._id) {
        try {
          await News.updateOne({ _id: out._id }, { $set: localized.dbSet }).catch(() => null);
        } catch (_) {}
      }

      if (localized && localized.out && localized.resolvedLang === desired && localized.translationPending === false) {
        out = withCoverImageUrl(localized.out);
        out.requestedLang = desired;
        out.resolvedLang = desired;
        out.isTranslated = true;
        out.summary = out.description || out.summary || '';
      } else {
        out.requestedLang = desired;
      }
    } else {
      out.requestedLang = desired;
    }

    try { delete out.translations; } catch (_) {}
    try { delete out.translationStatus; } catch (_) {}
    try { delete out.translationError; } catch (_) {}
    try { delete out.translationNextRetryAt; } catch (_) {}
    attachLocalizationFields(out, desired);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ message: e?.message || String(e) });
  }
}

module.exports = {
  listPublicNews,
  listPublicNewsTranslations,
  getPublicNewsByTranslationKey,
  getPublicNewsBySlugOrId,
  getPublicNewsBySlug,
  translatePublicNews,
};
