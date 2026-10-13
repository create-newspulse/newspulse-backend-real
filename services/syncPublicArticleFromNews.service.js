const PublicArticle = require('../models/Article');
const { canonicalizeSlug, slugifyUnicode } = require('../lib/slug');
const { INDIA_STATES_UTS, isValidStateSlug } = require('../src/utils/locationTagger');
const { ensureTrackTag, normalizeTrackValue } = require('./communitySubmissionWorkflow');
const { normalizeSpotlightPriority } = require('./spotlightPriority.service');
const { buildPublicPulseDialogueFromArticle } = require('./pulseDialogue.service');
const { getStoryKeys, UNOWNED_PUBLIC_COPY_FILTER } = require('./articleSlugUniqueness.service');
const News = require('../models/News');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];
const SPONSORED_ARTICLE_FIELDS = [
  'isSponsored', 'isSponsoredArticle', 'sponsorName', 'sponsorLabel', 'sponsorDisclosure',
  'sponsorCtaText', 'sponsorCtaUrl', 'sponsorFeatureEligible', 'sponsorFeatureLinkedId',
];

function sponsoredArticleFields(doc) {
  return Object.fromEntries(SPONSORED_ARTICLE_FIELDS
    .filter(field => doc?.[field] !== undefined).map(field => [field, doc[field]]));
}

function withGroupTranslations(doc, groupDocs, options = {}) {
  const out = doc.toObject ? doc.toObject() : { ...doc };
  if (!Array.isArray(groupDocs)) return out;
  out.translations = { ...out.translations };
  out.translationStatus = { ...out.translationStatus };
  for (const member of groupDocs) {
    const lang = normalizeLang(member.language || member.lang);
    if (!lang) continue;
    const bucket = { title: member.title, summary: member.description || member.summary, content: member.content };
    const ready = isPubliclyVisibleNewsArticle(member, options) && _hasFullTranslationBucket(bucket);
    out.translationStatus[lang] = ready ? 'ready' : 'pending';
    if (ready) out.translations[lang] = {
      ...bucket, provider: member.translatedByProvider === 'openai' ? 'openai' : 'manual',
      generatedAt: member.updatedAt || member.publishedAt,
    };
    else delete out.translations[lang];
  }
  return out;
}

async function syncNewsTranslationBuckets(groupDocs, options = {}) {
  const now = options.now || new Date();
  const futureVisibilityDates = groupDocs.map(doc => {
    const bucket = { title: doc.title, summary: doc.description || doc.summary, content: doc.content };
    if (!normalizeLang(doc.language || doc.lang) || !_hasFullTranslationBucket(bucket)) return null;
    const visibleAt = new Date(Math.max(...[
      doc.publishedAt, doc.publishAt, doc.scheduledAt, doc.embargoUntil, doc.workflow?.embargoUntil,
    ].map(value => value == null ? 0 : new Date(value).getTime())));
    return visibleAt > now && isPubliclyVisibleNewsArticle(doc, { now: visibleAt }) ? visibleAt : null;
  }).filter(Boolean);
  const refreshAt = futureVisibilityDates.length
    ? new Date(Math.min(...futureVisibilityDates.map(value => value.getTime()))) : null;
  for (const doc of groupDocs) {
    const next = withGroupTranslations(doc, groupDocs, { ...options, now });
    doc.translations = next.translations;
    doc.translationStatus = next.translationStatus;
    doc.publicVisibilityRefreshAt = refreshAt;
    if (typeof doc.save === 'function') {
      await doc.save({ validateModifiedOnly: true, session: options.session });
    } else {
      const result = await News.updateOne({ _id: doc._id }, {
        $set: {
          translations: next.translations, translationStatus: next.translationStatus,
          publicVisibilityRefreshAt: refreshAt,
        },
      }, { session: options.session });
      if (!result.acknowledged || result.matchedCount !== 1) {
        throw Object.assign(new Error('Article group changed. Reload and retry.'), { statusCode: 409 });
      }
    }
  }
}

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
  if (s0 === 'gujarati' || s0 === 'guj' || s0 === 'gj') return 'gu';
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

function _normalizeEditorialTypeForCategory(category, value) {
  const categoryNorm = String(category || '').trim().toLowerCase();
  if (categoryNorm !== 'editorial') return undefined;
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'editorial' || s === 'special_story') return s;
  return 'editorial';
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

async function _syncPublicArticleFromNews(newsDoc, options = {}) {
  if (!newsDoc) return null;
  newsDoc = withGroupTranslations(newsDoc, options.groupDocs, options);

  const categoryNorm = String(newsDoc.category || '').trim().toLowerCase();

  const slug = normalizeSlug(newsDoc.slug);
  if (!slug) return null;

  const normalizedStatus = _safeStr(newsDoc.status).toLowerCase() || 'draft';
  const isPublished = normalizedStatus === 'published';
  const language = normalizeLang(newsDoc.language || newsDoc.lang) || 'en';
  const originalLang = normalizeLang(newsDoc.originalLang) || language;
  const track = normalizeTrackValue(newsDoc.track);
  const fromDoc = newsDoc.geo && typeof newsDoc.geo === 'object' && !Array.isArray(newsDoc.geo) ? newsDoc.geo : null;
  const location = newsDoc.location && typeof newsDoc.location === 'object' && !Array.isArray(newsDoc.location) ? newsDoc.location : null;
  let tags = ensureTrackTag(Array.isArray(newsDoc.tags) ? newsDoc.tags : [], track);
  const fromTags = _geoFromTags(tags);
  const geo = {};
  for (const field of ['state', 'district', 'city']) {
    if (categoryNorm === 'regional') {
      const value = _normalizeNullableString(fromDoc?.[field])
        || _normalizeNullableString(location?.[`${field}Slug`])
        || _normalizeNullableString(location?.[field])
        || _normalizeNullableString(newsDoc[field])
        || fromTags[field];
      geo[field] = field === 'state'
        ? (canonicalStateSlugFromAny(value) || value || null)
        : (value ? slugifyUnicode(value, { maxLength: 80 }) || null : null);
    } else {
      geo[field] = fromDoc && fromDoc[field] !== undefined
        ? fromDoc[field]
        : ((location && location[`${field}Slug`] !== undefined) ? location[`${field}Slug`] : fromTags[field]);
    }
  }
  // The exact Regional category denotes the Gujarat desk, independent of article text.
  if (newsDoc.category === 'regional') geo.state = canonicalStateSlugFromAny('gujarat');
  if (categoryNorm === 'regional') {
    if (location) tags = _mergeLocationTags(tags, location);
    if (Object.values(geo).some(Boolean)) tags = _mergeLocationTags(tags, geo);
  }
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
  const pulseDialogue = await buildPublicPulseDialogueFromArticle(newsDoc);

  const update = {
    title: newsDoc.title,
    slug,
    slugs: newsDoc.slugs || null,
    summary: newsDoc.description || null,
    content: newsDoc.content || null,

    translationKey: _safeStr(newsDoc.translationKey) || null,
    translationGroupId: _safeStr(newsDoc.translationGroupId) || (_safeStr(newsDoc.translationKey) || null),
    sourceNewsId: newsDoc._id || null,
    sourceArticleId: newsDoc.sourceArticleId || newsDoc._id || null,
    sourceLanguage: normalizeLang(newsDoc.sourceLanguage) || originalLang,
    syncMode: String(newsDoc.syncMode || 'auto').trim().toLowerCase() || 'auto',
    lastSyncedAt: newsDoc.lastSyncedAt || null,
    syncVersion: Number.isFinite(Number(newsDoc.syncVersion)) ? Number(newsDoc.syncVersion) : 0,
    contentFingerprint: _safeStr(newsDoc.contentFingerprint) || null,

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
    editorialType: _normalizeEditorialTypeForCategory(newsDoc.category, newsDoc.editorialType),
    track,
    status: normalizedStatus || (isPublished ? 'published' : 'draft'),
    scheduledAt: newsDoc.scheduledAt || null,
    publishAt: newsDoc.publishAt || null,
    publishedAt: newsDoc.publishedAt || null,
    locked: newsDoc.locked === true || newsDoc.workflow?.locked === true,
    embargoUntil: [newsDoc.embargoUntil, newsDoc.workflow?.embargoUntil]
      .map(_normalizeNullableDate).filter(Boolean).sort((a, b) => b - a)[0] || null,
    visibility: newsDoc.visibility || null,
    isPrivate: newsDoc.isPrivate === true,
    deletedAt: normalizedStatus === 'deleted' ? (newsDoc.deletedAt || new Date()) : null,
    spotlightEnabled: Boolean(newsDoc.spotlightEnabled),
    spotlightPinned: Boolean(newsDoc.spotlightPinned),
    spotlightPriority: normalizeSpotlightPriority(newsDoc.spotlightPriority),
    spotlightExpiresAt: newsDoc.spotlightExpiresAt || null,
    isSponsored: Boolean(newsDoc.isSponsoredArticle || newsDoc.isSponsored),
    isSponsoredArticle: Boolean(newsDoc.isSponsoredArticle || newsDoc.isSponsored),
    sponsorName: _safeStr(newsDoc.sponsorName) || null,
    sponsorLabel: _safeStr(newsDoc.sponsorLabel) || 'Sponsored',
    sponsorDisclosure: _safeStr(newsDoc.sponsorDisclosure) || null,
    sponsorCtaText: _safeStr(newsDoc.sponsorCtaText) || null,
    sponsorCtaUrl: _safeStr(newsDoc.sponsorCtaUrl) || null,
    sponsorFeatureEligible: Boolean(newsDoc.sponsorFeatureEligible),
    sponsorFeatureLinkedId: newsDoc.sponsorFeatureLinkedId || null,
    ...(pulseDialogue ? { pulseDialogue } : {}),
    ...(newsDoc.authorByline !== undefined ? { authorByline: newsDoc.authorByline } : {}),
    isBreaking: String(newsDoc.category || '').toLowerCase() === 'breaking',
    coverImage,
    externalUrls: Array.isArray(newsDoc.externalUrls) ? newsDoc.externalUrls.filter((v) => _isNonEmptyString(v)) : [],
    embeds: Array.isArray(newsDoc.embeds) ? newsDoc.embeds.filter((v) => _isNonEmptyString(v)) : [],
    gallery: Array.isArray(newsDoc.gallery) ? newsDoc.gallery.filter((v) => _isNonEmptyString(v)) : [],
    seo: newsDoc.seo && typeof newsDoc.seo === 'object' && !Array.isArray(newsDoc.seo)
      ? {
          metaTitle: _safeStr(newsDoc.seo.metaTitle) || null,
          metaDescription: _safeStr(newsDoc.seo.metaDescription) || null,
          canonicalUrl: _safeStr(newsDoc.seo.canonicalUrl) || null,
        }
      : { metaTitle: null, metaDescription: null, canonicalUrl: null },
    tags,
    geo,

    // Human-readable location fields (legacy). Only normalize for regional.
    ...(categoryNorm === 'regional'
      ? {
          state: (newsDoc.category === 'regional' ? STATE_SLUG_TO_DISPLAY.get(geo.state) : null)
            || _normalizeNullableString(location?.state)
            || _normalizeNullableString(newsDoc.state)
            || STATE_SLUG_TO_DISPLAY.get(canonicalStateSlugFromAny(geo.state))
            || null,
          district: _normalizeNullableString(location?.district) || _normalizeNullableString(newsDoc.district) || geo.district || null,
          city: _normalizeNullableString(location?.city) || _normalizeNullableString(newsDoc.city) || geo.city || null,
        }
      : {}),

    // State-wise national tags (copied from News)
    stateTags: Array.isArray(newsDoc.stateTags) ? newsDoc.stateTags : [],
    stateNames: Array.isArray(newsDoc.stateNames) ? newsDoc.stateNames : [],
  };

  const keys = getStoryKeys(newsDoc);
  const ownership = [UNOWNED_PUBLIC_COPY_FILTER];
  if (keys.length) ownership.push(
    { translationGroupId: { $in: keys } },
    { translationKey: { $in: keys } }
  );
  const or = [{ slug, $or: ownership }];
  if (newsDoc._id) or.unshift({ sourceNewsId: newsDoc._id });
  const previousSlug = normalizeSlug(options.previousDoc?.slug);
  if (previousSlug && previousSlug !== slug) or.push({
    slug: previousSlug, ...UNOWNED_PUBLIC_COPY_FILTER,
  });

  const updateOp = { $set: update };
  if (!pulseDialogue) updateOp.$unset = { pulseDialogue: '' };
  if (isPublished && !newsDoc.publishedAt) {
    // A legacy source without a timestamp must not republish an existing copy.
    delete update.publishedAt;
    updateOp.$setOnInsert = { publishedAt: new Date() };
  }

  return PublicArticle.findOneAndUpdate(
    { $or: or },
    updateOp,
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true, session: options.session }
  ).lean();
}

async function syncPublicArticleFromNews(newsDoc, options = {}) {
  const logger = options.logger || console;
  try {
    const saved = await _syncPublicArticleFromNews(newsDoc, options);
    if (!saved?._id) throw new Error('Public article synchronization produced no record');
    return saved;
  } catch (error) {
    const conflict = error?.code === 11000 || error?.code === 11001;
    logger.warn?.('[articles.syncPublicArticleFromNews] failed', {
      code: conflict ? 'SLUG_CONFLICT' : 'PUBLIC_ARTICLE_SYNC_FAILED',
      sourceNewsId: newsDoc?._id ? String(newsDoc._id) : null,
    });
    if (options.throwOnError) {
      throw Object.assign(new Error(conflict ? 'Slug already exists' : 'Public article synchronization failed. Retry the operation.'), {
        status: conflict ? 409 : 503, statusCode: conflict ? 409 : 503,
        code: conflict ? 'SLUG_CONFLICT' : 'PUBLIC_ARTICLE_SYNC_FAILED', cause: error,
      });
    }
    return null;
  }
}

module.exports = {
  syncPublicArticleFromNews,
  syncNewsTranslationBuckets,
  sponsoredArticleFields,
};
