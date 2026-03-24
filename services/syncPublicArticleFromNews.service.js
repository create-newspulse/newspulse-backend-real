const PublicArticle = require('../models/Article');
const { canonicalizeSlug, slugifyUnicode } = require('../lib/slug');
const { INDIA_STATES_UTS, isValidStateSlug } = require('../src/utils/locationTagger');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

const STATE_SLUG_TO_DISPLAY = (() => {
  const m = new Map();
  for (const it of Array.isArray(INDIA_STATES_UTS) ? INDIA_STATES_UTS : []) {
    const slug = String(it?.slug || '').trim().toLowerCase();
    const display = String(it?.display || '').trim();
    if (slug && display) m.set(slug, display);
  }
  return m;
})();

const STATE_ALIAS_SLUG_TO_CANON = (() => {
  const m = new Map();
  for (const it of Array.isArray(INDIA_STATES_UTS) ? INDIA_STATES_UTS : []) {
    const canon = String(it?.slug || '').trim().toLowerCase();
    if (!canon) continue;
    m.set(canon, canon);
    const aliases = Array.isArray(it?.aliases) ? it.aliases : [];
    for (const a of aliases) {
      const as = slugifyUnicode(String(a || ''), { maxLength: 80 });
      if (as) m.set(as, canon);
    }
  }
  // Legacy abbreviation.
  m.set('gj', 'gujarat');
  return m;
})();

function canonicalStateSlugFromAny(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const slug = slugifyUnicode(raw, { maxLength: 80 });
  if (!slug) return null;
  if (isValidStateSlug(slug)) return slug;
  const mapped = STATE_ALIAS_SLUG_TO_CANON.get(slug);
  return mapped && isValidStateSlug(mapped) ? mapped : null;
}

function _mergeLocationTags(tagsArr, loc) {
  const tags = Array.isArray(tagsArr) ? tagsArr.filter((t) => typeof t === 'string' && t.trim()) : [];
  const out = [];
  const seen = new Set();

  const add = (t) => {
    const s = String(t || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const t of tags) add(t);

  const stateSlug = loc?.state ? canonicalStateSlugFromAny(loc.state) : null;
  const districtSlug = loc?.district ? slugifyUnicode(String(loc.district), { maxLength: 80 }) : null;
  const citySlug = loc?.city ? slugifyUnicode(String(loc.city), { maxLength: 80 }) : null;

  if (stateSlug) add(`state:${stateSlug}`);
  if (districtSlug) add(`district:${districtSlug}`);
  if (citySlug) add(`city:${citySlug}`);

  return out;
}

function normalizeLang(v) {
  const s0 = String(v ?? '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

function normalizeSlug(slug) {
  return canonicalizeSlug(slug);
}

function _safeStr(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.trim() ? s : '';
}

function _normalizeProvider(v) {
  if (v === null || v === undefined) return 'google';
  const s = String(v).trim().toLowerCase();
  if (!s) return 'google';
  if (s === 'google' || s === 'openai' || s === 'manual') return s;
  return 'google';
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _hasFullTranslationBucket(b) {
  const bucket = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  return _isNonEmptyString(bucket.title) && _isNonEmptyString(bucket.summary) && _isNonEmptyString(bucket.content);
}

function _normalizeStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'ready' || s === 'failed' || s === 'pending') return s;
  return 'pending';
}

function _pickPerLangObj(src, normalizeFn, fallback) {
  const s = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  return {
    en: normalizeFn(s.en, 'en', fallback),
    hi: normalizeFn(s.hi, 'hi', fallback),
    gu: normalizeFn(s.gu, 'gu', fallback),
  };
}

function _normalizeNullableString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function _normalizeNullableDate(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function _geoFromTags(tagsArr) {
  const tags = Array.isArray(tagsArr) ? tagsArr : [];
  const out = { state: null, district: null, city: null };

  for (const t0 of tags) {
    const t = typeof t0 === 'string' ? t0.trim() : '';
    if (!t) continue;
    const idx = t.indexOf(':');
    if (idx <= 0) continue;

    const k = t.slice(0, idx).trim().toLowerCase();
    const vRaw = t.slice(idx + 1).trim();
    if (!vRaw) continue;

    if (k !== 'state' && k !== 'district' && k !== 'city') continue;
    const v = slugifyUnicode(vRaw, { maxLength: 80 });
    if (!v) continue;
    out[k] = v;
  }

  return out;
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

  // Never store provider=null; always default to google.
  // Even empty buckets get provider=google so schema enums never see null.
  out.provider = _normalizeProvider(s.provider);

  // Only stamp generatedAt when a full translation exists.
  if (!full) out.generatedAt = null;

  return out;
}

async function syncPublicArticleFromNews(newsDoc, options = {}) {
  const logger = options.logger || console;
  if (!newsDoc) return null;

  const categoryNorm = String(newsDoc.category || '').trim().toLowerCase();

  const slug = normalizeSlug(newsDoc.slug);
  if (!slug) return null;

  const isPublished = String(newsDoc.status || '').toLowerCase() === 'published';
  const language = normalizeLang(newsDoc.language || newsDoc.lang) || 'en';
  const originalLang = normalizeLang(newsDoc.originalLang) || language;
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

    translationKey: _safeStr(newsDoc.translationKey) || null,
    translationGroupId: _safeStr(newsDoc.translationGroupId) || (_safeStr(newsDoc.translationKey) || null),
    sourceNewsId: newsDoc._id || null,

    language,
    originalLang,

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

    translationStatus: _pickPerLangObj(newsDoc.translationStatus, (v) => _normalizeStatus(v), 'pending'),
    translationError: _pickPerLangObj(newsDoc.translationError, (v) => _normalizeNullableString(v), null),
    translationNextRetryAt: _pickPerLangObj(newsDoc.translationNextRetryAt, (v) => _normalizeNullableDate(v), null),
    translationUpdatedAt: _pickPerLangObj(newsDoc.translationUpdatedAt, (v) => _normalizeNullableDate(v), null),

    category: newsDoc.category,
    status: isPublished ? 'published' : 'draft',
    publishedAt: isPublished ? (newsDoc.publishedAt || new Date()) : null,
    isBreaking: String(newsDoc.category || '').toLowerCase() === 'breaking',
    coverImage,
    tags: (() => {
      const baseTags = Array.isArray(newsDoc.tags) ? newsDoc.tags : [];
      const loc = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location)
        ? {
            state: newsDoc.location.state ?? null,
            district: newsDoc.location.district ?? null,
            city: newsDoc.location.city ?? null,
          }
        : null;

      // For regional stories, always ensure stable location tags exist.
      // These tags are additive and should not affect /latest, homepage modules, or category feeds.
      if (categoryNorm === 'regional' && loc) {
        return _mergeLocationTags(baseTags, loc);
      }
      return baseTags;
    })(),

    geo: (() => {
      const fromDoc = newsDoc.geo && typeof newsDoc.geo === 'object' && !Array.isArray(newsDoc.geo) ? newsDoc.geo : null;
      const mergedTags = Array.isArray(newsDoc.tags) ? newsDoc.tags : [];
      const fromTags = _geoFromTags(mergedTags);
      const fromLocation = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location) ? newsDoc.location : null;

      const pickedState = fromDoc && fromDoc.state !== undefined
        ? fromDoc.state
        : ((fromLocation && fromLocation.stateSlug !== undefined) ? fromLocation.stateSlug : fromTags.state);
      const canonState = categoryNorm === 'regional' ? canonicalStateSlugFromAny(pickedState) : null;

      return {
        state: canonState || pickedState || null,
        district: fromDoc && fromDoc.district !== undefined
          ? fromDoc.district
          : ((fromLocation && fromLocation.districtSlug !== undefined) ? fromLocation.districtSlug : fromTags.district),
        city: fromDoc && fromDoc.city !== undefined
          ? fromDoc.city
          : ((fromLocation && fromLocation.citySlug !== undefined) ? fromLocation.citySlug : fromTags.city),
      };
    })(),

    // Human-readable location fields (legacy). Only normalize for regional.
    ...(categoryNorm === 'regional'
      ? {
          state: (() => {
            const loc = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location) ? newsDoc.location : null;
            const s = loc && loc.state ? String(loc.state).trim() : '';
            if (s) return s;
            const canon = canonicalStateSlugFromAny(loc?.stateSlug) || canonicalStateSlugFromAny(newsDoc?.geo?.state);
            return canon ? (STATE_SLUG_TO_DISPLAY.get(canon) || null) : null;
          })(),
          district: (() => {
            const loc = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location) ? newsDoc.location : null;
            const s = loc && loc.district ? String(loc.district).trim() : '';
            return s || null;
          })(),
          city: (() => {
            const loc = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location) ? newsDoc.location : null;
            const s = loc && loc.city ? String(loc.city).trim() : '';
            return s || null;
          })(),
        }
      : {}),

    // State-wise national tags (copied from News)
    stateTags: Array.isArray(newsDoc.stateTags) ? newsDoc.stateTags : [],
    stateNames: Array.isArray(newsDoc.stateNames) ? newsDoc.stateNames : [],
  };

  try {
    const or = [{ slug }];
    if (newsDoc._id) or.unshift({ sourceNewsId: newsDoc._id });

    const saved = await PublicArticle.findOneAndUpdate(
      { $or: or },
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
