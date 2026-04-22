const express = require('express');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
// CMS/admin "articles" are stored in the News collection in this codebase.
// Keep an alias named Article for routes that treat these as "Articles".
const Article = News;
const mongoose = require('mongoose');
const { requireAdminAuth } = require('../middleware/adminAuth');
const PushHistory = require('../models/PushHistory');
const { buildPublicCategoryFilter, getCanonicalPublicCategoryKey } = require('../lib/categories');
const { canonicalizeSlug, detectSlugLocale, getSlugCandidates, safeDecodeURIComponent, slugifyUnicode } = require('../lib/slug');
const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');
const { INDIA_STATES_UTS, tagStatesFromText, isValidStateSlug } = require('../src/utils/locationTagger');
const {
  localizeFromNewsTranslations,
  localizeFromArticleI18n,
} = require('../services/newsI18n.service');

const { ensureOnDemandNewsTranslation } = require('../services/newsOnDemandTranslation.service');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');

const { mapArticleForLang, localizeArticleForLang } = require('../services/mapArticleForLang');

const {
  buildPubliclyVisibleNewsArticleFilter,
  buildPubliclyVisiblePublicArticleFilter,
} = require('../services/publicArticleVisibility.service');

const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { ensureTrackTag, normalizeTrackValue } = require('../services/communitySubmissionWorkflow');
const {
  normalizeTranslationGroupKey,
  prepareSourceSyncMetadata,
  syncTranslationGroupFromMaster,
} = require('../services/translationGroupSync.service');
const {
  getPublicContentGroupKey,
  getPublicContentLookup,
  buildPublicContentSiblingOrClauses,
  pickBestLocalizedGroupDoc,
} = require('../services/publicCategoryListing.service');
const { buildTranslationGroupStatus } = require('../services/translationGroupStatus');
const {
  buildPendingTranslationState,
  buildPublishTranslationState,
  markPublishTranslationPending,
  enqueueTranslateAndSave,
} = require('../services/publishAsyncTranslation.service');
const { invalidateArticleCaches } = require('../lib/cache');


// Router used by NewsPulse Admin Panel (/add) for Save Draft / Publish
const router = express.Router();

async function markPublicCopiesDraftFromNewsDoc(newsDoc, options = {}) {
  const logger = options.logger || console;
  try {
    if (!newsDoc) return;

    const groupKey = normalizeTranslationGroupKey(newsDoc.translationKey)
      || normalizeTranslationGroupKey(newsDoc.translationGroupId);
    const slugSet = new Set();

    if (newsDoc.slug) slugSet.add(String(newsDoc.slug).trim());
    const slugsObj = newsDoc.slugs && typeof newsDoc.slugs === 'object' && !Array.isArray(newsDoc.slugs) ? newsDoc.slugs : null;
    for (const k of ['en', 'hi', 'gu']) {
      const v = slugsObj && slugsObj[k] ? String(slugsObj[k]).trim() : '';
      if (v) slugSet.add(v);
    }

    const slugList = Array.from(slugSet).filter(Boolean);
    const or = [];

    if (newsDoc._id) or.push({ sourceNewsId: newsDoc._id });
    if (slugList.length) {
      or.push({ slug: { $in: slugList } });
      or.push({ 'slugs.en': { $in: slugList } });
      or.push({ 'slugs.hi': { $in: slugList } });
      or.push({ 'slugs.gu': { $in: slugList } });
    }
    if (groupKey) {
      or.push({ translationKey: groupKey });
      or.push({ translationGroupId: groupKey });
    }

    if (!or.length) return;
    await PublicArticle.updateMany(
      { $or: or },
      { $set: { status: 'draft', publishedAt: null } },
      { runValidators: false }
    );
  } catch (e) {
    try {
      logger.warn?.('[publicCopies][markDraft] failed', { message: e?.message || String(e) });
    } catch (_) {}
  }
}

function isAutoTranslateOnReadEnabled() {
  const s = String(process.env.ENABLE_AUTO_TRANSLATE_ON_READ ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

async function tryAcquireNewsTranslationLock({ id, lang, now = new Date() }) {
  const desired = normalizeLanguage(lang);
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

async function localizeNewsDocWithOptionalTranslate({ docLike, desiredLang, logger = console }) {
  const desired = normalizeLanguage(desiredLang);
  if (!desired) {
    const base = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
    return { out: docLike, resolvedLang: base, translationPending: false, isTranslated: false };
  }

  // Cached localization (strict from requested bucket)
  const cached = localizeFromNewsTranslations(docLike, desired);
  if (!cached || !cached.translationPending) {
    const isTranslated = cached && cached.resolvedLang === desired;
    return { ...cached, isTranslated };
  }

  // Optional: translate-on-read, guarded by env + provider config.
  if (!isAutoTranslateOnReadEnabled() || !isGoogleTranslateConfigured()) {
    return { ...cached, isTranslated: false };
  }

  const now = new Date();
  const lockOwner = await tryAcquireNewsTranslationLock({ id: docLike?._id, lang: desired, now });
  const localized = await ensureOnDemandNewsTranslation({
    doc: docLike,
    requestedLang: desired,
    logger,
    lockOwner,
    now,
  });

  if (localized && localized.dbSet && docLike && docLike._id) {
    try {
      await News.updateOne({ _id: docLike._id }, { $set: localized.dbSet }).catch(() => null);
    } catch (_) {}
  }

  const out = localized && localized.out ? localized.out : docLike;
  const resolvedLang = localized && localized.resolvedLang ? localized.resolvedLang : (cached.resolvedLang || desired);
  const translationPending = !!(localized && localized.translationPending);
  const isTranslated = resolvedLang === desired && translationPending === false;
  return { out, resolvedLang, translationPending, isTranslated };
}

// Helpers
function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(Boolean).map(t => String(t).trim()).filter(Boolean);
  return String(tags)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
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

function _stripUndefinedKeysInPlace(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

function _stripHtmlToText(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input);
  // Remove tags; keep plain text. (Lightweight; avoids new deps.)
  const noTags = raw
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, ' ')
    .replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _excerptFromRichText(input, maxLen = 180) {
  const text = _stripHtmlToText(input);
  if (!text) return '';
  const out = text.length > maxLen ? text.slice(0, maxLen) : text;
  return out.trim();
}

function _isBlankString(v) {
  return v === '' || (typeof v === 'string' && v.trim() === '');
}

function _normalizeOptionalString(v) {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return undefined;
  const lowered = s.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null') return undefined;
  return typeof v === 'string' ? v : s;
}

function _normalizeOptionalObjectId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return mongoose.Types.ObjectId.isValid(raw) ? raw : undefined;
}

function _parseIntOrDefault(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function _parseSafeSort(raw, allowedFields, fallbackField = 'updatedAt', fallbackDir = -1) {
  const out = {};
  const s = String(raw || '').trim();
  if (s) {
    for (const partRaw of s.split(',')) {
      const part = String(partRaw || '').trim();
      if (!part) continue;
      const desc = part.startsWith('-');
      const field = desc ? part.slice(1) : part;
      if (!allowedFields.has(field)) continue;
      out[field] = desc ? -1 : 1;
    }
  }

  if (!Object.keys(out).length) {
    out[fallbackField] = fallbackDir;
  }
  return out;
}

function normalizeSlug(slug) {
  return canonicalizeSlug(slug);
}

function slugifyFromTitle(title) {
  return slugifyUnicode(title);
}

function normalizeLanguage(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

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

function _stripHtmlForLangDetect(v) {
  return String(v ?? '').replace(/<[^>]*>/g, ' ');
}

function _countUnicodeMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function inferLanguageFromDocText({ title, description, content } = {}) {
  // Very lightweight heuristic to prevent obvious mislabeling (e.g. Gujarati content saved as lang=en).
  // Use a small threshold to avoid flipping for a single borrowed word.
  const text = _stripHtmlForLangDetect(`${title || ''} ${description || ''} ${content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function normalizeRetryLang(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  if (s === 'all' || s === '') return 'all';
  return null;
}

function _isNationalCategory(category) {
  return String(category || '').trim().toLowerCase() === 'national';
}

function _computeNationalStateTags({ title, summary, content }) {
  const text = `${title || ''} ${summary || ''} ${content || ''}`;
  return tagStatesFromText(text);
}

function _escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _normalizeLocationValue(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : null;
}

function _locationSlugsFromValues({ state, district, city }) {
  const stateVal = _normalizeLocationValue(state);
  const districtVal = _normalizeLocationValue(district);
  const cityVal = _normalizeLocationValue(city);

  return {
    state: stateVal,
    district: districtVal,
    city: cityVal,
    stateSlug: stateVal ? slugifyUnicode(stateVal, { maxLength: 80 }) : (stateVal === null ? null : undefined),
    districtSlug: districtVal ? slugifyUnicode(districtVal, { maxLength: 80 }) : (districtVal === null ? null : undefined),
    citySlug: cityVal ? slugifyUnicode(cityVal, { maxLength: 80 }) : (cityVal === null ? null : undefined),
  };
}

function _buildLocationQueryFromRequest(req) {
  const stateRaw = (req.query.state ?? '').toString();
  const districtRaw = (req.query.district ?? '').toString();
  const cityRaw = (req.query.city ?? '').toString();

  const state = stateRaw.trim();
  const district = districtRaw.trim();
  const city = cityRaw.trim();

  const andClauses = [];

  if (state) {
    const slug = slugifyUnicode(state, { maxLength: 80 });
    const rx = new RegExp(`^\\s*${_escapeRegex(state)}\\s*$`, 'i');
    andClauses.push({ $or: [{ 'location.stateSlug': slug }, { 'location.state': rx }] });
  }

  if (district) {
    const slug = slugifyUnicode(district, { maxLength: 80 });
    const rx = new RegExp(`^\\s*${_escapeRegex(district)}\\s*$`, 'i');
    andClauses.push({ $or: [{ 'location.districtSlug': slug }, { 'location.district': rx }] });
  }

  if (city) {
    const slug = slugifyUnicode(city, { maxLength: 80 });
    const rx = new RegExp(`^\\s*${_escapeRegex(city)}\\s*$`, 'i');
    andClauses.push({ $or: [{ 'location.citySlug': slug }, { 'location.city': rx }] });
  }

  return andClauses;
}

function getTitleForLangFromDocLike(docLike, lang) {
  const desired = normalizeLanguage(lang);
  if (!desired) return '';

  const t = docLike && docLike.translations && docLike.translations[desired];
  const fromTranslations = t && typeof t.title === 'string' ? t.title : '';
  if (fromTranslations && fromTranslations.trim()) return fromTranslations;

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || null;
  if (baseLang === desired) return String(docLike?.title || '');
  return '';
}

function ensureNewsSlugs(docLike) {
  if (!docLike) return;
  const out = { ...(docLike.slugs || {}) };
  for (const lang of ['en', 'hi', 'gu']) {
    const t = getTitleForLangFromDocLike(docLike, lang);
    if (t && t.trim()) out[lang] = slugifyUnicode(t);
  }

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
  if (!out[baseLang] && docLike.title) {
    out[baseLang] = slugifyUnicode(docLike.title);
  }

  docLike.slugs = out;
  if ((!docLike.slug || !String(docLike.slug).trim()) && out[baseLang]) {
    docLike.slug = out[baseLang];
  }
}

async function assertSlugUnique(slug, excludeId) {
  if (!slug) return;
  const candidates = getSlugCandidates(slug);
  const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
  const q = { slug: slugFilter };
  if (excludeId) q._id = { $ne: excludeId };
  const existing = await News.findOne(q).select('_id slug').lean();
  if (existing) {
    const err = new Error('Slug already exists');
    err.status = 409;
    throw err;
  }
}

function validatePublishable(doc) {
  const missing = [];
  if (!doc?.title) missing.push('title');
  if (!doc?.slug) missing.push('slug');
  if (!doc?.category) missing.push('category');
  if (!doc?.language) missing.push('language');
  if (!doc?.content) missing.push('content');
  return missing;
}

function withCoverImageUrl(obj) {
  if (!obj) return obj;
  const coverUrl =
    (obj.coverImage && typeof obj.coverImage === 'object' && !Array.isArray(obj.coverImage) ? obj.coverImage.url : null) ||
    (typeof obj.coverImage === 'string' ? obj.coverImage : null) ||
    obj.coverImageUrl ||
    obj.imageURL ||
    null;

  const coverImageObj = (() => {
    const v = obj.coverImage;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return {
        url: v.url ? String(v.url) : (coverUrl || null),
        publicId: v.publicId ? String(v.publicId) : null,
        alt: v.alt ? String(v.alt) : null,
      };
    }
    if (typeof v === 'string') return { url: v, publicId: null, alt: null };
    if (coverUrl) return { url: coverUrl, publicId: null, alt: null };
    return v; // leave undefined/null as-is
  })();

  return { ...obj, coverImageUrl: coverUrl, ...(coverImageObj ? { coverImage: coverImageObj } : {}) };
}

function _logPublicCategoryListingDebug(payload) {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return;
  try {
    console.log('[public.category][debug]', payload);
  } catch (_) {}
}

async function _resolveGroupedCategoryNewsItems({
  baseQuery,
  categoryQuery,
  requestedLang,
  page,
  limit,
  sortParam,
  categorySlug,
  normalizedCategoryKey,
}) {
  const matchedDocs = await News.find(categoryQuery).sort(sortParam).lean();

  const lookups = (matchedDocs || []).map((doc) => getPublicContentLookup(doc));
  const groupKeys = Array.from(new Set(lookups.map((entry) => entry.groupKey).filter(Boolean)));
  const canonicalSlugs = Array.from(new Set(
    lookups
      .filter((entry) => !entry.groupKey && entry.canonicalSlug)
      .map((entry) => entry.canonicalSlug)
  ));

  let siblingDocs = [];
  const siblingClauses = buildPublicContentSiblingOrClauses({ groupKeys, canonicalSlugs });
  if (siblingClauses.length) {
    const siblingQuery = {
      ...baseQuery,
      $and: [
        ...((baseQuery && Array.isArray(baseQuery.$and)) ? baseQuery.$and : []),
        { $or: siblingClauses },
      ],
    };
    siblingDocs = await News.find(siblingQuery).sort(sortParam).lean();
  }

  const groupedDocs = new Map();
  for (const doc of [...(matchedDocs || []), ...(siblingDocs || [])]) {
    const key = getPublicContentGroupKey(doc);
    if (!groupedDocs.has(key)) groupedDocs.set(key, []);
    groupedDocs.get(key).push(doc);
  }

  const includedKeys = Array.from(new Set((matchedDocs || []).map((doc) => getPublicContentGroupKey(doc))));
  const resolvedItems = includedKeys
    .map((key) => {
      const picked = pickBestLocalizedGroupDoc(groupedDocs.get(key) || [], requestedLang, { fallbackToBase: true });
      if (!picked) return null;

      const doc = withCoverImageUrl(picked.doc);
      const mapped = picked.mapped;
      return {
        ...doc,
        title: mapped.title,
        description: mapped.summary,
        summary: mapped.summary,
        content: mapped.content,
        slug: mapped.slug,
        canonicalSlug: mapped.canonicalSlug,
        lang: mapped.lang,
        language: mapped.lang,
        requestedLang: mapped.requestedLang,
        resolvedLang: mapped.resolvedLang,
        isTranslated: mapped.isTranslated,
        __sortPublishedAt: new Date(doc.publishedAt || 0).getTime() || 0,
        __sortCreatedAt: new Date(doc.createdAt || 0).getTime() || 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.__sortPublishedAt !== left.__sortPublishedAt) return right.__sortPublishedAt - left.__sortPublishedAt;
      return right.__sortCreatedAt - left.__sortCreatedAt;
    });

  _logPublicCategoryListingDebug({
    requestedLocale: requestedLang || null,
    requestedCategorySlug: categorySlug || null,
    normalizedCategoryKey: normalizedCategoryKey || null,
    matchedTranslationGroupIds: groupKeys,
    returnedArticles: resolvedItems.map((item) => ({
      id: String(item._id || ''),
      language: String(item.language || item.lang || ''),
      translationGroupId: String(item.translationKey || item.translationGroupId || ''),
    })),
  });

  const total = resolvedItems.length;
  const skip = (page - 1) * limit;
  const items = resolvedItems.slice(skip, skip + limit).map((item) => {
    try {
      delete item.__sortPublishedAt;
      delete item.__sortCreatedAt;
    } catch (_) {}
    return item;
  });

  return { items, total };
}

function mapStatusToWorkflowStage(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'published') return 'PUBLISHED';
  if (s === 'scheduled') return 'SCHEDULED';
  if (s === 'archived') return 'ARCHIVED';
  if (s === 'deleted') return 'REJECTED';
  return 'DRAFT';
}

function ensureTranslationGroupIdForDoc(doc) {
  if (!doc) return null;
  const existing = String(doc.translationGroupId || '').trim();
  if (existing) return existing;
  const id = new mongoose.Types.ObjectId().toString();
  doc.translationGroupId = id;
  return id;
}

function getActor(req) {
  const raw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
  const byRole = raw === 'founder' ? 'FOUNDER' : (raw === 'staff' ? 'STAFF' : (raw === 'legal' ? 'LEGAL' : 'EDITOR'));
  // Keep byUserId optional; admin IDs are not guaranteed to be ObjectId
  const byUserId = null;
  return { byRole, byUserId };
}

async function syncArticleFromNews(doc) {
  try {
    return await syncPublicArticleFromNews(doc, { logger: console });
  } catch (_) {
    return null;
  }
}

function _parseStringListInput(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      return _parseStringListInput(JSON.parse(raw));
    } catch (_) {}
  }
  return raw.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function _parseSeoPayload(value) {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof parsed === 'string') {
    const raw = parsed.trim();
    if (!raw) {
      return { metaTitle: null, metaDescription: null, canonicalUrl: null };
    }
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = { metaTitle: raw, metaDescription: null, canonicalUrl: null };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { metaTitle: null, metaDescription: null, canonicalUrl: null };
  }
  const metaTitle = _normalizeOptionalString(parsed.metaTitle ?? parsed.title) ?? null;
  const metaDescription = _normalizeOptionalString(parsed.metaDescription ?? parsed.description) ?? null;
  const canonicalUrl = _normalizeOptionalString(parsed.canonicalUrl ?? parsed.canonical) ?? null;
  return { metaTitle, metaDescription, canonicalUrl };
}

function _normalizeSourceArticleId(value) {
  const raw = _normalizeOptionalString(value);
  if (!raw) return undefined;
  return mongoose.Types.ObjectId.isValid(raw) ? raw : undefined;
}

function _normalizeOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function _normalizeOptionalNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function _normalizeOptionalDateInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function _isSourceTranslationDoc(docLike, fallbackId) {
  const ownId = String(docLike?._id || fallbackId || '').trim();
  const sourceId = String(docLike?.sourceArticleId || '').trim();
  return !sourceId || (ownId && sourceId === ownId);
}

function _buildSharedSyncFieldsFromBody(body) {
  const externalUrls = _parseStringListInput(body?.externalUrls);
  const embeds = _parseStringListInput(body?.embeds);
  const gallery = _parseStringListInput(body?.gallery);
  const seo = _parseSeoPayload(body?.seo);
  const sourceArticleId = _normalizeSourceArticleId(body?.sourceArticleId);
  const trackRaw = body?.track;
  const normalizedTrack = trackRaw === undefined ? undefined : normalizeTrackValue(trackRaw);
  const spotlightEnabled = _normalizeOptionalBoolean(body?.spotlightEnabled);
  const spotlightPinned = _normalizeOptionalBoolean(body?.spotlightPinned);
  const spotlightPriority = _normalizeOptionalNumber(body?.spotlightPriority);
  const spotlightExpiresAt = _normalizeOptionalDateInput(body?.spotlightExpiresAt);

  return {
    ...(externalUrls !== undefined ? { externalUrls } : {}),
    ...(embeds !== undefined ? { embeds } : {}),
    ...(gallery !== undefined ? { gallery } : {}),
    ...(seo !== undefined ? { seo } : {}),
    ...(sourceArticleId !== undefined ? { sourceArticleId } : {}),
    ...(normalizedTrack !== undefined ? { track: normalizedTrack } : {}),
    ...(spotlightEnabled !== undefined ? { spotlightEnabled: Boolean(spotlightEnabled) } : {}),
    ...(spotlightPinned !== undefined ? { spotlightPinned: Boolean(spotlightPinned) } : {}),
    ...(spotlightPriority !== undefined ? { spotlightPriority: spotlightPriority === null ? 0 : spotlightPriority } : {}),
    ...(spotlightExpiresAt !== undefined ? { spotlightExpiresAt } : {}),
  };
}

function _buildSponsoredArticleFieldsFromBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const isSponsoredArticle = _normalizeOptionalBoolean(
    b.isSponsoredArticle !== undefined ? b.isSponsoredArticle : b.isSponsored
  );
  const sponsorFeatureEligible = _normalizeOptionalBoolean(b.sponsorFeatureEligible);
  const sponsorName = _normalizeOptionalString(b.sponsorName);
  const sponsorLabel = _normalizeOptionalString(b.sponsorLabel);
  const sponsorDisclosure = _normalizeOptionalString(b.sponsorDisclosure);
  const sponsorCtaText = _normalizeOptionalString(b.sponsorCtaText);
  const sponsorCtaUrl = _normalizeOptionalString(b.sponsorCtaUrl);
  const sponsorFeatureLinkedId = _normalizeOptionalObjectId(b.sponsorFeatureLinkedId);

  if (b.sponsorFeatureLinkedId !== undefined && sponsorFeatureLinkedId === undefined) {
    return { ok: false, status: 400, message: 'sponsorFeatureLinkedId must be a valid id' };
  }

  if (sponsorCtaUrl !== undefined && sponsorCtaUrl !== null) {
    const valid = sponsorCtaUrl.startsWith('http://') || sponsorCtaUrl.startsWith('https://') || sponsorCtaUrl.startsWith('/');
    if (!valid) {
      return { ok: false, status: 400, message: 'sponsorCtaUrl must start with https://, http://, or /' };
    }
  }

  const hasSponsoredPayload = [
    'isSponsored',
    'isSponsoredArticle',
    'sponsorName',
    'sponsorLabel',
    'sponsorDisclosure',
    'sponsorCtaText',
    'sponsorCtaUrl',
    'sponsorFeatureEligible',
    'sponsorFeatureLinkedId',
  ].some((key) => Object.prototype.hasOwnProperty.call(b, key));

  return {
    ok: true,
    value: {
      ...(isSponsoredArticle !== undefined ? {
        isSponsored: Boolean(isSponsoredArticle),
        isSponsoredArticle: Boolean(isSponsoredArticle),
      } : {}),
      ...(sponsorName !== undefined ? { sponsorName } : {}),
      ...((sponsorLabel !== undefined || hasSponsoredPayload) ? { sponsorLabel: sponsorLabel || 'Sponsored' } : {}),
      ...(sponsorDisclosure !== undefined ? { sponsorDisclosure } : {}),
      ...(sponsorCtaText !== undefined ? { sponsorCtaText } : {}),
      ...(sponsorCtaUrl !== undefined ? { sponsorCtaUrl } : {}),
      ...(sponsorFeatureEligible !== undefined ? { sponsorFeatureEligible: Boolean(sponsorFeatureEligible) } : {}),
      ...(sponsorFeatureLinkedId !== undefined ? { sponsorFeatureLinkedId } : {}),
    },
  };
}

async function syncMasterArticleGroup(doc, options = {}) {
  if (!doc || !_isSourceTranslationDoc(doc)) return null;
  try {
    return await syncTranslationGroupFromMaster(doc, {
      logger: console,
      reason: options.reason || 'article_sync',
      invalidate: options.invalidate,
    });
  } catch (_) {
    return null;
  }
}

// POST /api/articles → create a new article (CMS/admin)
router.post('/articles', requireAdminAuth, async (req, res, next) => {
  try {
    const body0 = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    // Normalize legacy payloads: CMS sends `summary`, schema requires `description`.
    if (body0.summary !== undefined && body0.description === undefined) {
      body0.description = body0.summary;
    }

    const {
      title: titleRaw,
      slug,
      summary: summaryRaw,
      description: descriptionRaw,
      content: contentRaw,
      body: bodyRaw,
      category,
      track: trackRaw,
      language,
      lang: langRaw,
      tags,
      status,
      scheduledAt,
      imageURL,
      coverImageUrl,
      coverImage,
    } = body0;
    const sharedSyncFields = _buildSharedSyncFieldsFromBody(body0);
    const sponsoredArticleFields = _buildSponsoredArticleFieldsFromBody(body0);
    if (trackRaw !== undefined && sharedSyncFields.track === null) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid Youth Pulse track' });
    }
    if (!sponsoredArticleFields.ok) {
      return res.status(sponsoredArticleFields.status).json({ ok: false, success: false, message: sponsoredArticleFields.message });
    }

    const tagsArr = ensureTrackTag(parseTags(tags), sharedSyncFields.track);
    const geo = _geoFromTags(tagsArr);

    // Guard against accidental "undefined"/"null" string inputs from form-data payloads.
    const title = _normalizeOptionalString(titleRaw);
    const summary = _normalizeOptionalString(summaryRaw);
    const description = _normalizeOptionalString(descriptionRaw);
    const content = _normalizeOptionalString(contentRaw);
    const body = _normalizeOptionalString(bodyRaw);

    if (!title) {
      return res.status(400).json({ ok: false, success: false, message: 'Title is required' });
    }

    let normalizedDescription = summary !== undefined ? summary : description;
    // If summary/description missing, derive from content/body.
    if (normalizedDescription === undefined) {
      const excerpt = _excerptFromRichText(content ?? body ?? '', 180);
      if (excerpt) normalizedDescription = excerpt;
    }
    if (normalizedDescription === undefined || normalizedDescription === null || _isBlankString(String(normalizedDescription))) {
      return res.status(400).json({ ok: false, success: false, message: 'Summary (description) is required' });
    }
    normalizedDescription = String(normalizedDescription).trim();

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const allowedStatuses = new Set(['draft', 'scheduled', 'published', 'archived', 'deleted']);
    const initialStatus = status ? String(status).toLowerCase() : 'draft';
    if (status !== undefined && !allowedStatuses.has(initialStatus)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status' });
    }

    let resolvedSlug = normalizeSlug(slug);
    if (!resolvedSlug) resolvedSlug = slugifyFromTitle(title);
    if (!resolvedSlug) {
      return res.status(400).json({ ok: false, success: false, message: 'Slug is required (or title must be slugifiable)' });
    }

    // Ensure slug uniqueness; if auto-generated from title, try a few suffixes.
    if (!normalizeSlug(slug)) {
      let candidate = resolvedSlug;
      for (let i = 0; i < 20; i++) {
        try {
          await assertSlugUnique(candidate);
          resolvedSlug = candidate;
          break;
        } catch (e) {
          if (e?.status !== 409) throw e;
          candidate = `${resolvedSlug}-${i + 2}`;
        }
      }
      await assertSlugUnique(resolvedSlug);
    } else {
      await assertSlugUnique(resolvedSlug);
    }

    const coverObj = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
    const resolvedCoverImageUrl = coverImageUrl ?? imageURL ?? (coverObj ? coverObj.url : undefined);
    const absoluteCoverImageUrl = resolvedCoverImageUrl !== undefined ? absolutizeUploadsUrl(resolvedCoverImageUrl) : null;
    const workflowStage = mapStatusToWorkflowStage(initialStatus);
    const now = new Date();
    const actor = getActor(req);
    const translationGroupId = (req.body && req.body.translationGroupId) ? String(req.body.translationGroupId).trim() : '';

    const locationBody = (req.body && req.body.location && typeof req.body.location === 'object' && !Array.isArray(req.body.location))
      ? req.body.location
      : {};
    const loc = _locationSlugsFromValues({
      state: locationBody.state ?? req.body?.state,
      district: locationBody.district ?? req.body?.district,
      city: locationBody.city ?? req.body?.city,
    });

    const languageInput = language !== undefined ? language : langRaw;
    const langFromPayload = normalizeLanguage(languageInput);
    const inferredLang = inferLanguageFromDocText({ title, description: normalizedDescription, content: content ?? body ?? '' });
    const langNorm = (
      (langFromPayload && langFromPayload !== 'en')
        ? langFromPayload
        : (inferredLang && inferredLang !== 'en')
          ? inferredLang
          : (langFromPayload || 'en')
    );
    const slugs = { ...(req.body && req.body.slugs && typeof req.body.slugs === 'object' ? req.body.slugs : {}) };
    slugs[langNorm] = resolvedSlug;
    // Best-effort for other languages if titles exist in `translations` payload.
    if (req.body && req.body.translations && typeof req.body.translations === 'object') {
      for (const k of ['en', 'hi', 'gu']) {
        const t = req.body.translations && req.body.translations[k];
        const titleForSlug = t && typeof t.title === 'string' ? t.title : '';
        if (titleForSlug && titleForSlug.trim()) {
          slugs[k] = slugifyUnicode(titleForSlug);
        }
      }
    }

    const willBeNational = _isNationalCategory(category);
    const { stateTags, stateNames } = willBeNational
      ? _computeNationalStateTags({ title, summary: normalizedDescription, content: content ?? body ?? '' })
      : { stateTags: [], stateNames: [] };

    const createDoc = {
      title,
      description: normalizedDescription,
      content: content ?? body ?? '',
      category,
      ...(sharedSyncFields.track !== undefined ? { track: sharedSyncFields.track } : {}),
      language: langNorm,
      lang: langNorm,
      originalLang: langNorm,
      stateTags,
      stateNames,
      ...(loc.state !== undefined || loc.district !== undefined || loc.city !== undefined ? {
        location: {
          state: loc.state,
          district: loc.district,
          city: loc.city,
          stateSlug: loc.stateSlug,
          districtSlug: loc.districtSlug,
          citySlug: loc.citySlug,
        },
      } : {}),
      translationGroupId: translationGroupId || new mongoose.Types.ObjectId().toString(),
      ...sharedSyncFields,
      ...sponsoredArticleFields.value,
      tags: tagsArr,
      geo,
      status: initialStatus || 'draft',
      scheduledAt: scheduled,
      imageURL: imageURL ?? resolvedCoverImageUrl,
      coverImageUrl: absoluteCoverImageUrl ?? null,
      ...(coverObj || absoluteCoverImageUrl ? {
        coverImage: {
          url: coverObj && coverObj.url !== undefined ? absolutizeUploadsUrl(coverObj.url) : (absoluteCoverImageUrl ?? null),
          publicId: coverObj && coverObj.publicId !== undefined ? (coverObj.publicId || null) : null,
          alt: coverObj && coverObj.alt !== undefined ? (coverObj.alt || null) : null,
        },
      } : {}),
      slug: resolvedSlug,
      slugs,

      workflowStage,
      workflowUpdatedAt: now,
      workflowHistory: [{
        at: now,
        byUserId: actor.byUserId,
        byRole: actor.byRole,
        action: 'MOVE_STAGE',
        fromStage: null,
        toStage: workflowStage,
        note: 'Created',
      }],
    };

    if (initialStatus === 'published') {
      const pending = buildPublishTranslationState({
        baseLang: langNorm,
        title,
        summary: normalizedDescription,
        content: content ?? body ?? '',
        existing: createDoc,
        now,
      });

      createDoc.deletedAt = null;
      createDoc.publishedAt = now;
      createDoc.publishAt = null;
      createDoc.scheduledAt = null;
      createDoc.translations = pending.translations;
      createDoc.translationStatus = pending.translationStatus;
      createDoc.translationError = pending.translationError;
      createDoc.translationNextRetryAt = pending.translationNextRetryAt;
      createDoc.translationUpdatedAt = pending.translationUpdatedAt;
    }

    _stripUndefinedKeysInPlace(createDoc);

    const doc = await News.create(createDoc);

    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
      await doc.save({ validateModifiedOnly: true });
      await syncMasterArticleGroup(doc, {
        reason: 'article_create',
        invalidate: String(doc.status || '').toLowerCase() === 'published',
      });
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;

    if (String(doc.status || '').toLowerCase() === 'published') {
      await syncArticleFromNews(doc);
      enqueueTranslateAndSave(doc._id, { logger: console });
    }

    invalidateArticleCaches().catch(() => {});

    return res.status(201).json({
      ok: true,
      success: true,
      status: 201,
      message: 'Article created',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (err) {
    if (err?.status === 409) {
      return res.status(409).json({ ok: false, success: false, message: err.message || 'Slug already exists' });
    }
    return next(err);
  }
});

// GET /api/articles → list articles (CMS/admin Manage News)
router.get('/articles', requireAdminAuth, async (req, res, next) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      const readyState = (mongoose.connection && typeof mongoose.connection.readyState === 'number')
        ? mongoose.connection.readyState
        : -1;
      return res.status(503).json({
        ok: false,
        success: false,
        message: 'DB unavailable',
        readyState,
        path: req.originalUrl,
      });
    }

    // Client may send page=0; clamp to >= 1
    const page = Math.max(_parseIntOrDefault(req.query.page, 1), 1);
    const limit = _clampInt(_parseIntOrDefault(req.query.limit, 20), 1, 100);

    // Only allow safe sort fields.
    // Support "-updatedAt" => { updatedAt: -1 }
    const allowedSortFields = new Set(['updatedAt', 'createdAt', 'publishedAt']);
    const sortParam = _parseSafeSort(req.query.sort, allowedSortFields, 'updatedAt', -1);
    const statusRaw = (req.query.status || '').toString();
    const langQueryRaw = (req.query.lang || req.query.language || '').toString().trim();
    const categoryRaw = (req.query.category || '').toString().trim();
    const qRaw = (req.query.q || '').toString().trim();
    const fromRaw = (req.query.from || '').toString().trim();
    const toRaw = (req.query.to || '').toString().trim();
    const query = {};
    if (statusRaw) {
      const statuses = statusRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (statuses.length > 0) {
        // Include docs where status matches OR status is missing (legacy)
        query.$or = [
          { status: { $in: statuses } },
          { status: { $exists: false } },
        ];
      }
    }

    const locationAnd = _buildLocationQueryFromRequest(req);
    if (locationAnd.length) {
      query.$and = (query.$and || []).concat(locationAnd);

      // For regional feeds, callers usually want published-only.
      // Keep explicit status=... overriding this default.
      if (!statusRaw) {
        query.status = 'published';
      }
    }

    const langNorm = normalizeLanguage(langQueryRaw);
    if (langNorm) {
      query.$and = (query.$and || []).concat([{ $or: [{ language: langNorm }, { lang: langNorm }] }]);
    }

    if (categoryRaw) {
      const categoryNorm = getCanonicalPublicCategoryKey(categoryRaw);
      if (categoryNorm === 'regional') {
        // Regional listing should include breaking stories too.
        query.category = { $in: ['regional', 'breaking'] };
      } else {
        query.category = buildPublicCategoryFilter(categoryNorm || categoryRaw);
      }
    }
    if (qRaw) {
      const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$and = (query.$and || []).concat([
        {
          $or: [
            { title: rx },
            { description: rx },
            { content: rx },
          ],
        },
      ]);
    }

    const fromDate = fromRaw ? new Date(fromRaw) : null;
    const toDate = toRaw ? new Date(toRaw) : null;
    if (fromDate && !isNaN(fromDate)) {
      query.createdAt = query.createdAt || {};
      query.createdAt.$gte = fromDate;
    }
    if (toDate && !isNaN(toDate)) {
      query.createdAt = query.createdAt || {};
      query.createdAt.$lte = toDate;
    }
    const skip = (page - 1) * limit;

    const [itemsRaw, total] = await Promise.all([
      News.find(query).sort(sortParam).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    const items = (itemsRaw || []).map(withCoverImageUrl);

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: { items, page, limit, total },

      // Backward-compatible fields used by older admin panel builds
      items,
      articles: items,
      total,
      page,
      limit,
      sort: sortParam,
    });
  } catch (err) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    console.error('[ADMIN_ARTICLES][list] failed', {
      method: req.method,
      url: req.originalUrl,
      message: err?.message || String(err),
      name: err?.name,
      // Avoid logging stack in prod logs only if you prefer; leaving it helps debug.
      stack: isProd ? undefined : err?.stack,
      query: req.query,
    });
    return res.status(500).json({
      ok: false,
      success: false,
      message: 'Internal error',
      path: req.originalUrl,
      ...(isProd ? {} : { error: err?.message || String(err) }),
    });
  }
});

// GET /api/public/articles → public site listing (published only)
router.get('/public/articles', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const sortParam = (req.query.sort || '-publishedAt').toString();
    const status = String(req.query.status || 'published').toLowerCase();
    if (status !== 'published') {
      return res.status(400).json({ ok: false, success: false, message: 'Only status=published is allowed' });
    }

    // Prefer explicit query lang, otherwise use negotiated language (e.g. header x-lang).
    // Keep backward-compat behavior for non-standard explicit query values.
    const explicitLangRaw = (req.query.lang || req.query.language || '').toString().trim();
    const langQueryRaw = (explicitLangRaw || req.lang || '').toString().trim();
    const categoryRaw = (req.query.category || '').toString().trim();
    const qRaw = (req.query.q || '').toString().trim();

    const query = buildPubliclyVisibleNewsArticleFilter();

    const locationAnd = _buildLocationQueryFromRequest(req);
    if (locationAnd.length) {
      query.$and = (query.$and || []).concat(locationAnd);
    }

    const desired = normalizeLanguage(langQueryRaw);
    const categoryNorm = categoryRaw ? getCanonicalPublicCategoryKey(categoryRaw) : null;
    const isGroupedCategoryListing = Boolean(categoryRaw);

    if (!isGroupedCategoryListing && (desired === 'hi' || desired === 'en')) {
      const originalMatch = _buildOriginalLangMatch(desired);
      const readyMatch = _buildReadyTranslationMatch(desired);
      query.$and = (query.$and || []).concat([{ $or: [originalMatch, readyMatch].filter(Boolean) }]);
    } else if (!isGroupedCategoryListing && explicitLangRaw) {
      const langNorm = normalizeLanguage(explicitLangRaw);
      if (langNorm) {
        query.$and = (query.$and || []).concat([{ $or: [{ language: langNorm }, { lang: langNorm }] }]);
      } else {
        // Backward compatible: preserve old behavior for non-standard explicit lang.
        query.$and = (query.$and || []).concat([{ $or: [{ language: explicitLangRaw }, { lang: explicitLangRaw }] }]);
      }
    }

    if (categoryRaw) {
      if (categoryNorm === 'regional') {
        query.category = { $in: ['regional', 'breaking'] };
      } else {
        query.category = buildPublicCategoryFilter(categoryNorm || categoryRaw);
      }
    }
    if (qRaw) {
      const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ title: rx }, { description: rx }, { content: rx }];
    }

    let items = [];
    let total = 0;

    if (isGroupedCategoryListing) {
      const groupedRequestedLang = desired || 'en';
      const baseQuery = buildPubliclyVisibleNewsArticleFilter();
      const baseLocationAnd = _buildLocationQueryFromRequest(req);
      if (baseLocationAnd.length) {
        baseQuery.$and = (baseQuery.$and || []).concat(baseLocationAnd);
      }
      if (qRaw) {
        const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        baseQuery.$or = [{ title: rx }, { description: rx }, { content: rx }];
      }

      const resolved = await _resolveGroupedCategoryNewsItems({
        baseQuery,
        categoryQuery: query,
        requestedLang: groupedRequestedLang,
        page,
        limit,
        sortParam,
        categorySlug: categoryRaw,
        normalizedCategoryKey: categoryNorm || categoryRaw,
      });
      items = resolved.items;
      total = resolved.total;
    } else {
      const skip = (page - 1) * limit;
      const [itemsRaw, count] = await Promise.all([
        News.find(query).sort(sortParam).skip(skip).limit(limit).lean(),
        News.countDocuments(query),
      ]);

      items = (itemsRaw || []).map(withCoverImageUrl);
      total = count;

      if (desired) {
        items = items
          .map((doc) => {
            const mapped = localizeArticleForLang(doc, desired, { fallbackToBase: desired === 'gu' });
            if (!mapped) return null;
            return {
              ...doc,
              title: mapped.title,
              description: mapped.summary,
              summary: mapped.summary,
              content: mapped.content,
              slug: mapped.slug,
              canonicalSlug: mapped.canonicalSlug,
              lang: mapped.lang,
              language: mapped.lang,
              requestedLang: mapped.requestedLang,
              resolvedLang: mapped.resolvedLang,
              isTranslated: mapped.isTranslated,
            };
          })
          .filter(Boolean);
      }
    }

    return res.status(200).json({ ok: true, success: true, status: 200, data: { items, page, limit, total } });
  } catch (err) {
    return next(err);
  }
});

function _normalizeOriginalLang(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function _buildOriginalLangMatch(desiredLang) {
  const desired = _normalizeOriginalLang(desiredLang);
  if (!desired) return null;
  const upper = desired.toUpperCase();
  return {
    $or: [
      { originalLang: { $in: [desired, upper] } },
      // Backward compatibility: older docs may only have lang/language.
      {
        $and: [
          { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
          { $or: [{ lang: { $in: [desired, upper] } }, { language: { $in: [desired, upper] } }] },
        ],
      },
    ],
  };
}

function _buildReadyTranslationMatch(desiredLang) {
  const desired = _normalizeOriginalLang(desiredLang);
  if (!desired) return null;
  // Clean UX: include ONLY fully-ready translations.
  return {
    $and: [
      { [`translationStatus.${desired}`]: 'ready' },
      { [`translations.${desired}.title`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.summary`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.content`]: { $exists: true, $ne: '' } },
    ],
  };
}

function _pickLocaleAwareSlug(doc, requestedLang) {
  const target = normalizeLanguage(requestedLang) || normalizeLanguage(doc?.originalLang) || normalizeLanguage(doc?.lang || doc?.language) || 'en';
  const slugs = doc && doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs) ? doc.slugs : null;
  const localized = slugs && slugs[target] ? String(slugs[target]).trim() : '';
  if (localized) return localized;
  if (doc && doc.slug) {
    const base = String(doc.slug).trim();
    if (base) return base;
  }
  return (slugs && (slugs.en || slugs.hi || slugs.gu)) || null;
}

function _resolveImageUrlFromNewsDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const coverUrl =
    (doc.coverImage && typeof doc.coverImage === 'object' && !Array.isArray(doc.coverImage) ? doc.coverImage.url : null) ||
    doc.coverImageUrl ||
    doc.imageURL ||
    doc.imageUrl ||
    null;
  return coverUrl ? String(coverUrl) : null;
}

function _buildFlexibleSlugValuePattern(valueSlug) {
  const v = String(valueSlug || '').trim();
  if (!v) return '';
  // Accept either hyphen or spaces (or nothing) between slug segments.
  return _escapeRegex(v).replace(/-/g, '(?:-|\\s)*');
}

function _buildFlexibleSlugValueRegex(valueSlug) {
  const flexible = _buildFlexibleSlugValuePattern(valueSlug);
  if (!flexible) return null;
  return new RegExp(`^\\s*${flexible}\\s*$`, 'i');
}

function _buildGeoOrTagClause(field, tagPrefix, valueSlug) {
  const v = String(valueSlug || '').trim();
  if (!v) return null;
  const valueRx = _buildFlexibleSlugValueRegex(v);
  const valuePattern = _buildFlexibleSlugValuePattern(v) || _escapeRegex(v);
  const tagRx = new RegExp(`^\\s*${_escapeRegex(tagPrefix)}\\s*:\\s*${valuePattern}\\s*$`, 'i');
  return {
    $or: [
      { [`geo.${field}`]: v },
      ...(valueRx ? [{ [`geo.${field}`]: valueRx }] : []),
      { tags: tagRx },
    ],
  };
}

function _sanitizeOptionalQueryParam(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'undefined' || lower === 'null') return '';
  return s;
}

function _isTruthyEnv(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function _sanitizeDistrictCityValue(v) {
  const s = _sanitizeOptionalQueryParam(v);
  if (!s) return '';
  const lower = s.toLowerCase().replace(/\s+/g, ' ').trim();

  // Frontends commonly send district=all or similar sentinel values.
  // State-level regional feeds must NOT be blocked by these.
  if (
    lower === 'all' ||
    lower === 'any' ||
    lower === '*' ||
    lower === 'all districts' ||
    lower === 'all-districts' ||
    lower === 'alldistricts' ||
    lower === 'all cities' ||
    lower === 'all-cities' ||
    lower === 'allcities'
  ) {
    return '';
  }
  return s;
}

function _stripLocationPrefix(v, prefix) {
  const s = String(v || '').trim();
  if (!s) return '';
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return s;
  const rx = new RegExp(`^\s*${_escapeRegex(p)}\s*:\s*`, 'i');
  return s.replace(rx, '').trim();
}

function _getStateAliasSlugs(stateSlug) {
  const s = String(stateSlug || '').trim().toLowerCase();
  if (!s) return [];

  const stateObj = Array.isArray(INDIA_STATES_UTS)
    ? INDIA_STATES_UTS.find((it) => String(it?.slug || '').trim().toLowerCase() === s)
    : null;

  const aliasValues = [];
  aliasValues.push(s);

  // Add known short-code variants for legacy data.
  if (s === 'gujarat') aliasValues.push('gj');

  const aliases = stateObj && Array.isArray(stateObj.aliases) ? stateObj.aliases : [];
  for (const a of aliases) {
    const slug = slugifyUnicode(String(a || ''), { maxLength: 80 });
    if (slug) aliasValues.push(slug);
  }

  // Ensure uniqueness.
  const out = [];
  const seen = new Set();
  for (const v of aliasValues) {
    const vv = String(v || '').trim();
    if (!vv) continue;
    if (seen.has(vv)) continue;
    seen.add(vv);
    out.push(vv);
  }
  return out;
}

function _buildGeoOrTagClauseAny(field, tagPrefix, values, options = {}) {
  const vals = Array.isArray(values) ? values : [values];
  const cleaned = vals.map((v) => String(v || '').trim()).filter(Boolean);
  if (!cleaned.length) return null;

  const patterns = [];
  for (const v of cleaned) {
    const p = _buildFlexibleSlugValuePattern(v) || _escapeRegex(v);
    if (p) patterns.push(p);
  }
  const tagAlt = patterns.length ? `(?:${patterns.join('|')})` : null;
  const tagRx = tagAlt ? new RegExp(`^\\s*${_escapeRegex(tagPrefix)}\\s*:\\s*${tagAlt}\\s*$`, 'i') : null;

  const ors = [];
  ors.push({ [`geo.${field}`]: { $in: cleaned } });
  if (tagRx) ors.push({ tags: tagRx });

  // Legacy fallback: older public Article copies sometimes stored raw state/district/city in top-level fields.
  const legacyField = options.legacyField ? String(options.legacyField) : '';
  if (legacyField) {
    const rxParts = cleaned.map((v) => _buildFlexibleSlugValueRegex(v)).filter(Boolean);
    for (const rx of rxParts) ors.push({ [legacyField]: rx });
  }

  return { $or: ors };
}

async function _handlePublicRegionalQuery(req, res, next, options = {}) {
  try {
    res.set('Cache-Control', 'no-store');

    const stateInput = options.stateRawOverride !== undefined
      ? options.stateRawOverride
      : (req.query.state || req.query.stateSlug || '');

    const rawState0 = _sanitizeOptionalQueryParam(safeDecodeURIComponent(stateInput || ''));
    const rawState = _stripLocationPrefix(rawState0, 'state');
    if (!rawState) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'state is required' });
    }

    const stateSlug = String(slugifyUnicode(rawState, { maxLength: 80 }) || '').trim().toLowerCase();
    if (!stateSlug) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid state' });
    }
    if (!isValidStateSlug(stateSlug)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid state' });
    }

    const desired = normalizeLanguage(req.query.lang || req.query.language) || 'gu';

    const rawDistrict0 = _sanitizeDistrictCityValue(safeDecodeURIComponent(req.query.district || ''));
    const rawCity0 = _sanitizeDistrictCityValue(safeDecodeURIComponent(req.query.city || ''));
    const rawDistrict = _stripLocationPrefix(rawDistrict0, 'district');
    const rawCity = _stripLocationPrefix(rawCity0, 'city');
    const districtSlug = rawDistrict ? String(slugifyUnicode(rawDistrict, { maxLength: 80 }) || '').trim().toLowerCase() : '';
    const citySlug = rawCity ? String(slugifyUnicode(rawCity, { maxLength: 80 }) || '').trim().toLowerCase() : '';

    const page = Math.max(_parseIntOrDefault(req.query.page, 1), 1);
    const limit = _clampInt(_parseIntOrDefault(req.query.limit, 20), 1, 100);
    const skip = (page - 1) * limit;

    const andClauses = [];
    const stateAliases = _getStateAliasSlugs(stateSlug);
    const stateClause = _buildGeoOrTagClauseAny('state', 'state', stateAliases, { legacyField: 'state' });
    if (stateClause) andClauses.push(stateClause);
    if (districtSlug) {
      const districtClause = _buildGeoOrTagClauseAny('district', 'district', districtSlug, { legacyField: 'district' });
      if (districtClause) andClauses.push(districtClause);
    }
    if (citySlug) {
      const cityClause = _buildGeoOrTagClauseAny('city', 'city', citySlug, { legacyField: 'city' });
      if (cityClause) andClauses.push(cityClause);
    }

    const filter = buildPubliclyVisiblePublicArticleFilter();
    filter.category = 'regional';
    if (andClauses.length) {
      filter.$and = (filter.$and || []).concat(andClauses);
    }

    // Optional debug logging for live diagnosis.
    // Enable with DEBUG_REGIONAL_FEED=1 (or REGIONAL_FEED_DEBUG=1).
    const debugRegional = _isTruthyEnv(process.env.DEBUG_REGIONAL_FEED) || _isTruthyEnv(process.env.REGIONAL_FEED_DEBUG);
    if (debugRegional && stateSlug === 'gujarat') {
      const safeJson = (obj) => {
        try {
          return JSON.stringify(
            obj,
            (_k, v) => {
              if (v instanceof RegExp) return v.toString();
              return v;
            },
            2
          );
        } catch (_) {
          return '[unstringifiable]';
        }
      };

      try {
        console.log('[public.regional][debug] request', {
          path: req.path,
          stateInput: stateInput || null,
          rawState: rawState || null,
          stateSlug,
          rawDistrict: rawDistrict || null,
          districtSlug: districtSlug || null,
          rawCity: rawCity || null,
          citySlug: citySlug || null,
          lang: desired,
          page,
          limit,
          query: req.query,
        });
        console.log('[public.regional][debug] filter', safeJson(filter));
      } catch (_) {}
    }

    // Query rules:
    // - If requested lang matches the original language => show originals
    // - Else => show ONLY fully-ready cached translations for that language
    if (desired === 'hi' || desired === 'en') {
      const originalMatch = _buildOriginalLangMatch(desired);
      const readyMatch = _buildReadyTranslationMatch(desired);
      filter.$and = (filter.$and || []).concat([{ $or: [originalMatch, readyMatch].filter(Boolean) }]);
    }

    const [itemsRaw, total] = await Promise.all([
      PublicArticle.find(filter)
        .select('title summary content slug slugs language originalLang translations translationStatus coverImage publishedAt createdAt updatedAt geo tags category translationKey translationGroupId spotlightEnabled spotlightPinned spotlightPriority spotlightExpiresAt')
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PublicArticle.countDocuments(filter),
    ]);

    if ((_isTruthyEnv(process.env.DEBUG_REGIONAL_FEED) || _isTruthyEnv(process.env.REGIONAL_FEED_DEBUG)) && stateSlug === 'gujarat') {
      try {
        console.log('[public.regional][debug] result', { stateSlug, lang: desired, total, returned: (itemsRaw || []).length });
      } catch (_) {}
    }

    // Dedupe across language-variants of the same story.
    // Prefer originals in the requested lang over translated variants.
    const bestByKey = new Map();
    for (const doc of (itemsRaw || [])) {
      const imageUrl = _resolveImageUrlFromNewsDoc(doc);
      const mapped = localizeArticleForLang(doc, desired, { fallbackToBase: desired === 'gu' });
      if (!mapped) continue;

      const out = {
        _id: String(doc._id),
        slug: mapped.slug,
        canonicalSlug: mapped.canonicalSlug,
        slugs: doc.slugs || null,
        category: doc.category || null,
        stateSlug,
        imageUrl,
        title: mapped.title,
        summary: mapped.summary,
        content: mapped.content,
        generatedAt: mapped.generatedAt || null,
        provider: mapped.provider || 'google',
        __isTranslated: Boolean(mapped.isTranslated),
      };

      const canonicalSlug = String(mapped.canonicalSlug || '').trim();
      const groupKey = normalizeTranslationGroupKey(doc.translationKey)
        || normalizeTranslationGroupKey(doc.translationGroupId);
      const key = groupKey
        ? `group:${groupKey}`
        : (canonicalSlug ? `cslug:${canonicalSlug}` : (out.slug ? `slug:${out.slug}` : `id:${out._id}`));
      const prev = bestByKey.get(key);
      if (!prev) {
        bestByKey.set(key, out);
        continue;
      }
      if (prev.__isTranslated && !out.__isTranslated) {
        bestByKey.set(key, out);
      }
    }

    const items = Array.from(bestByKey.values()).map((it) => {
      try { delete it.__isTranslated; } catch (_) {}
      return it;
    });

    return res.status(200).json({ ok: true, success: true, status: 200, data: { items, page, limit, total, stateSlug, lang: desired } });
  } catch (err) {
    return next(err);
  }
}

// GET /api/public/regional?state=&district=&city=&lang=en|hi|gu
router.get('/public/regional', async (req, res, next) => {
  return _handlePublicRegionalQuery(req, res, next);
});

// GET /api/public/regional/:state?district=&city=&lang=en|hi|gu (legacy)
router.get('/public/regional/:state', async (req, res, next) => {
  return _handlePublicRegionalQuery(req, res, next, { stateRawOverride: req.params.state });
});

// GET /api/admin/articles/:id/translation-status
router.get('/articles/:id/translation-status', requireAdminAuth, async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }

    const doc = await News.findById(rawId)
      .select('title slug lang language originalLang translationStatus translationError translationUpdatedAt translationNextRetryAt translationKey translationGroupId')
      .lean();
    if (!doc) return res.status(404).json({ ok: false, success: false, message: 'Article not found' });

    const groupKey = String(doc.translationKey || doc.translationGroupId || '').trim();
    const groupDocs = groupKey
      ? await News.find({ $or: [{ translationKey: groupKey }, { translationGroupId: groupKey }] })
        .select('_id lang language originalLang translationKey translationGroupId title slug status')
        .lean()
      : [doc];
    const groupStatus = buildTranslationGroupStatus(doc, groupDocs);

    const baseLang = groupStatus.baseLang;
    const out = {
      id: String(doc._id),
      slug: doc.slug || null,
      title: doc.title || null,
      baseLang,
      translationGroupKey: groupKey || null,
      languageStates: groupStatus,
      perLang: {
        en: {
          status: doc?.translationStatus?.en ?? null,
          error: doc?.translationError?.en ?? null,
          updatedAt: doc?.translationUpdatedAt?.en ?? null,
          nextRetryAt: doc?.translationNextRetryAt?.en ?? null,
          present: groupStatus.perLang.en.present,
          presence: groupStatus.perLang.en.presence,
          isSource: groupStatus.perLang.en.isSource,
          isTranslatedChild: groupStatus.perLang.en.isTranslatedChild,
          sourceArticleId: groupStatus.perLang.en.sourceArticleId,
          childArticleId: groupStatus.perLang.en.childArticleId,
          articleId: groupStatus.perLang.en.articleId,
        },
        hi: {
          status: doc?.translationStatus?.hi ?? null,
          error: doc?.translationError?.hi ?? null,
          updatedAt: doc?.translationUpdatedAt?.hi ?? null,
          nextRetryAt: doc?.translationNextRetryAt?.hi ?? null,
          present: groupStatus.perLang.hi.present,
          presence: groupStatus.perLang.hi.presence,
          isSource: groupStatus.perLang.hi.isSource,
          isTranslatedChild: groupStatus.perLang.hi.isTranslatedChild,
          sourceArticleId: groupStatus.perLang.hi.sourceArticleId,
          childArticleId: groupStatus.perLang.hi.childArticleId,
          articleId: groupStatus.perLang.hi.articleId,
        },
        gu: {
          status: doc?.translationStatus?.gu ?? null,
          error: doc?.translationError?.gu ?? null,
          updatedAt: doc?.translationUpdatedAt?.gu ?? null,
          nextRetryAt: doc?.translationNextRetryAt?.gu ?? null,
          present: groupStatus.perLang.gu.present,
          presence: groupStatus.perLang.gu.presence,
          isSource: groupStatus.perLang.gu.isSource,
          isTranslatedChild: groupStatus.perLang.gu.isTranslatedChild,
          sourceArticleId: groupStatus.perLang.gu.sourceArticleId,
          childArticleId: groupStatus.perLang.gu.childArticleId,
          articleId: groupStatus.perLang.gu.articleId,
        },
      },
    };

    return res.json({ ok: true, success: true, data: out });
  } catch (e) {
    console.error('[ADMIN_ARTICLES][translation-status-error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Internal error' });
  }
});

// GET /api/articles/national/state/:stateSlug → published national articles filtered by stateTags
router.get('/articles/national/state/:stateSlug', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');

    const stateSlug = String(req.params.stateSlug || '').trim().toLowerCase();
    if (!stateSlug) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'stateSlug is required' });
    }
    if (!isValidStateSlug(stateSlug)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid stateSlug' });
    }

    const requestedLang = normalizeLanguage(req.query.lang || req.query.language);
    const desired = requestedLang || null;

    const page = Math.max(_parseIntOrDefault(req.query.page, 1), 1);
    const limit = _clampInt(_parseIntOrDefault(req.query.limit, 20), 1, 100);
    const skip = (page - 1) * limit;

    const query = buildPubliclyVisibleNewsArticleFilter();
    query.category = 'national';
    query.stateTags = stateSlug;
    if (desired === 'hi' || desired === 'en') {
      const originalMatch = _buildOriginalLangMatch(desired);
      const readyMatch = _buildReadyTranslationMatch(desired);
      query.$and = (query.$and || []).concat([{ $or: [originalMatch, readyMatch].filter(Boolean) }]);
    }
    const [itemsRaw, total] = await Promise.all([
      News.find(query).sort({ publishedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      News.countDocuments(query),
    ]);

    let items = (itemsRaw || []).map(withCoverImageUrl);
    if (desired) {
      const bestByKey = new Map();
      for (const doc of items) {
        const mapped = localizeArticleForLang(doc, desired, { fallbackToBase: desired === 'gu' });
        if (!mapped) continue;

        // Preserve the existing payload shape but localize fields.
        const out = { ...doc };
        out.title = mapped.title;
        out.description = mapped.summary;
        out.content = mapped.content;
        out.slug = mapped.slug;
        out.canonicalSlug = mapped.canonicalSlug;
        out.lang = mapped.lang;
        out.language = mapped.lang;
        out.translationProvider = mapped.provider || 'google';
        out.translationGeneratedAt = mapped.generatedAt || null;
        out.__isTranslated = Boolean(mapped.isTranslated);

        const canonicalSlug = String(mapped.canonicalSlug || '').trim();
        const groupKey = String(doc.translationKey || doc.translationGroupId || '').trim();
        const key = groupKey
          ? `group:${groupKey}`
          : (canonicalSlug ? `cslug:${canonicalSlug}` : (out.slug ? `slug:${out.slug}` : `id:${String(out._id || '')}`));
        const prev = bestByKey.get(key);
        if (!prev) {
          bestByKey.set(key, out);
          continue;
        }
        if (prev.__isTranslated && !out.__isTranslated) {
          bestByKey.set(key, out);
        }
      }

      items = Array.from(bestByKey.values()).map((it) => {
        try { delete it.__isTranslated; } catch (_) {}
        return it;
      });
    }
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: { items, page, limit, total, stateSlug, ...(desired ? { lang: desired } : {}) },
    });
  } catch (err) {
    return next(err);
  }
});

// Backward-compatible aliases for admin panel builds calling /api/news*
router.get('/news', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
});
router.get('/news/list', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
});
router.get('/news/all', (req, res, next) => {
  req.url = '/articles' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return router.handle(req, res, next);
});

// GET /api/articles/slug/:slug → lookup by slug (admin UI compatibility)
router.get('/articles/slug/:slug', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const raw = String(req.params.slug || '');
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    const slugNorm = normalizeSlug(decoded) || normalizeSlug(raw) || String(decoded || '').trim();
    if (!slugNorm) return res.status(200).json({ exists: false });

    // If DB is unavailable, don't 500 the admin UI.
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(200).json({ exists: false });
    }

    const query = {
      $or: [
        { slug: slugNorm },
        { 'slugs.en': slugNorm },
        { 'slugs.hi': slugNorm },
        { 'slugs.gu': slugNorm },
      ],
    };
    const doc = await News.findOne(query).lean().catch(() => null);
    const fallback = doc ? null : await PublicArticle.findOne(query).lean().catch(() => null);
    const out = doc || fallback;
    if (!out) return res.status(200).json({ exists: false });

    const langRaw = (req.query.lang || req.query.language || req.lang || '').toString().trim();
    const desired = normalizeLanguage(langRaw) || detectSlugLocale(out, raw);
    if (!desired) return res.status(200).json(withCoverImageUrl(out));

    const out0 = withCoverImageUrl(out);

    if (out0 && out0.translations && typeof out0.translations === 'object') {
      const localized = await localizeNewsDocWithOptionalTranslate({ docLike: out0, desiredLang: desired, logger: console });
      const canonicalSlug = _pickLocaleAwareSlug(out0, desired);
      return res.status(200).json({
        ...withCoverImageUrl(localized.out),
        slug: canonicalSlug || localized.out?.slug || out0.slug || null,
        canonicalSlug,
        localizedSlug: canonicalSlug,
        requestedLang: desired,
        resolvedLang: localized.resolvedLang,
        isTranslated: localized.isTranslated,
        translationPending: localized.translationPending,
      });
    }

    if (out0 && out0.i18n && typeof out0.i18n === 'object') {
      const localized = localizeFromArticleI18n(out0, desired);
      const canonicalSlug = _pickLocaleAwareSlug(out0, desired);
      return res.status(200).json({
        ...withCoverImageUrl(localized.out),
        slug: canonicalSlug || localized.out?.slug || out0.slug || null,
        canonicalSlug,
        localizedSlug: canonicalSlug,
        requestedLang: desired,
        resolvedLang: localized.resolvedLang,
        isTranslated: localized.resolvedLang === desired,
        translationPending: !!localized.translationPending,
      });
    }

    return res.status(200).json({
      ...out0,
      canonicalSlug: _pickLocaleAwareSlug(out0, desired),
      localizedSlug: _pickLocaleAwareSlug(out0, desired),
      requestedLang: desired,
      resolvedLang: normalizeLanguage(out0?.lang) || normalizeLanguage(out0?.language) || desired,
      isTranslated: false,
      translationPending: false,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/articles/by-slug/:slug → alias (some admin builds use this path)
router.get('/articles/by-slug/:slug', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const raw = String(req.params.slug || '');
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    const slugNorm = normalizeSlug(decoded) || normalizeSlug(raw) || String(decoded || '').trim();
    if (!slugNorm) return res.status(200).json({ exists: false });

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(200).json({ exists: false });
    }

    const query = {
      $or: [
        { slug: slugNorm },
        { 'slugs.en': slugNorm },
        { 'slugs.hi': slugNorm },
        { 'slugs.gu': slugNorm },
      ],
    };
    const doc = await News.findOne(query).lean().catch(() => null);
    const fallback = doc ? null : await PublicArticle.findOne(query).lean().catch(() => null);
    const out = doc || fallback;
    if (!out) return res.status(200).json({ exists: false });

    const langRaw = (req.query.lang || req.query.language || req.lang || '').toString().trim();
    const desired = normalizeLanguage(langRaw) || detectSlugLocale(out, raw);
    if (!desired) return res.status(200).json(withCoverImageUrl(out));

    const out0 = withCoverImageUrl(out);

    if (out0 && out0.translations && typeof out0.translations === 'object') {
      const localized = await localizeNewsDocWithOptionalTranslate({ docLike: out0, desiredLang: desired, logger: console });
      const canonicalSlug = _pickLocaleAwareSlug(out0, desired);
      return res.status(200).json({
        ...withCoverImageUrl(localized.out),
        slug: canonicalSlug || localized.out?.slug || out0.slug || null,
        canonicalSlug,
        localizedSlug: canonicalSlug,
        requestedLang: desired,
        resolvedLang: localized.resolvedLang,
        isTranslated: localized.isTranslated,
        translationPending: localized.translationPending,
      });
    }

    if (out0 && out0.i18n && typeof out0.i18n === 'object') {
      const localized = localizeFromArticleI18n(out0, desired);
      const canonicalSlug = _pickLocaleAwareSlug(out0, desired);
      return res.status(200).json({
        ...withCoverImageUrl(localized.out),
        slug: canonicalSlug || localized.out?.slug || out0.slug || null,
        canonicalSlug,
        localizedSlug: canonicalSlug,
        requestedLang: desired,
        resolvedLang: localized.resolvedLang,
        isTranslated: localized.resolvedLang === desired,
        translationPending: !!localized.translationPending,
      });
    }

    return res.status(200).json({
      ...out0,
      canonicalSlug: _pickLocaleAwareSlug(out0, desired),
      localizedSlug: _pickLocaleAwareSlug(out0, desired),
      requestedLang: desired,
      resolvedLang: normalizeLanguage(out0?.lang) || normalizeLanguage(out0?.language) || desired,
      isTranslated: false,
      translationPending: false,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/articles/:id → get single article by id
router.get('/articles/:id', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const rawId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const langQueryRaw = (req.query.lang || req.query.language || req.lang || '').toString().trim();
    const langNorm = normalizeLanguage(langQueryRaw);

    // Primary: CMS/admin articles stored in News collection.
    let doc = await News.findById(rawId).catch(() => null);

    // Fallback: some deployments/edit flows reference the public Article model by id.
    if (!doc) {
      doc = await PublicArticle.findById(rawId).catch(() => null);
    }

    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    const out0 = withCoverImageUrl(obj);

    const localized = await (async () => {
      if (!langNorm) {
        return {
          out: out0,
          resolvedLang: normalizeLanguage(out0?.lang) || normalizeLanguage(out0?.language) || 'en',
          translationPending: false,
          isTranslated: false,
        };
      }

      // News docs use `translations`; public Article uses `i18n`.
      if (out0 && out0.translations && typeof out0.translations === 'object') {
        return localizeNewsDocWithOptionalTranslate({ docLike: out0, desiredLang: langNorm, logger: console });
      }

      if (out0 && out0.i18n && typeof out0.i18n === 'object') {
        const r = localizeFromArticleI18n(out0, langNorm);
        return { ...r, isTranslated: r && r.resolvedLang === langNorm };
      }

      return { out: out0, resolvedLang: langNorm, translationPending: false, isTranslated: false };
    })();

    const out = localized.out;

    let translationGroupStatus;
    const isAdminArticleDetail = String(req.originalUrl || req.path || '').startsWith('/api/admin/')
      || String(req.originalUrl || req.path || '').startsWith('/admin-api/admin/')
      || String(req.originalUrl || req.path || '').startsWith('/admin-api/api/admin/');
    if (isAdminArticleDetail) {
      const groupKey = String(out0?.translationKey || out0?.translationGroupId || '').trim();
      const groupDocs = groupKey
        ? await News.find({ $or: [{ translationKey: groupKey }, { translationGroupId: groupKey }] })
          .select('_id lang language originalLang translationKey translationGroupId title slug status')
          .lean()
        : [out0];
      translationGroupStatus = buildTranslationGroupStatus(out0, groupDocs);
    }

    if (langNorm && localized.translationPending) {
      try {
        console.warn('[i18n-missing][articles.getById]', {
          id: rawId,
          slug: String(out0?.slug || ''),
          category: String(out0?.category || ''),
          requestedLang: langNorm,
          resolvedLang: localized.resolvedLang,
        });
      } catch (_) {}
    }
    // Compatibility: some admin frontends expect `data.article` (while others expect `article`).
    return res.json({
      ok: true,
      success: true,
      status: 200,
      article: out,
      data: { article: out },
      ...(translationGroupStatus ? { translationGroupStatus } : {}),
      ...(langNorm ? { requestedLang: langNorm, resolvedLang: localized.resolvedLang, isTranslated: !!localized.isTranslated, translationPending: !!localized.translationPending } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/articles/:id → update existing article by id (CMS/admin)
router.put('/articles/:id', requireAdminAuth, async (req, res, next) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const requestBody = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    // Normalize legacy payloads: CMS sends `summary`, schema requires `description`.
    if (requestBody.summary !== undefined && requestBody.description === undefined) {
      requestBody.description = requestBody.summary;
    }

    const {
      title: titleRaw,
      slug: slugRaw,
      summary: summaryRaw,
      description: descriptionRaw,
      content: contentRaw,
      body: bodyRaw,
      category: categoryRaw,
      track: trackRaw,
      language: languageRaw,
      lang: langRaw,
      tags,
      status,
      scheduledAt,
      imageURL: imageURLRaw,
      coverImageUrl: coverImageUrlRaw,
      coverImage,
    } = requestBody;
    const sharedSyncFields = _buildSharedSyncFieldsFromBody(requestBody);
    const sponsoredArticleFields = _buildSponsoredArticleFieldsFromBody(requestBody);
    if (trackRaw !== undefined && sharedSyncFields.track === null) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid Youth Pulse track' });
    }
    if (!sponsoredArticleFields.ok) {
      return res.status(sponsoredArticleFields.status).json({ ok: false, success: false, message: sponsoredArticleFields.message });
    }

    // Guard against accidental "undefined"/"null" string inputs from form-data payloads.
    const title = _normalizeOptionalString(titleRaw);
    const slug = _normalizeOptionalString(slugRaw);
    const summary = _normalizeOptionalString(summaryRaw);
    const description = _normalizeOptionalString(descriptionRaw);
    const content = _normalizeOptionalString(contentRaw);
    const bodyText = _normalizeOptionalString(bodyRaw);
    const category = _normalizeOptionalString(categoryRaw);
    const language = _normalizeOptionalString(languageRaw !== undefined ? languageRaw : langRaw);
    const imageURL = _normalizeOptionalString(imageURLRaw);
    const coverImageUrl = _normalizeOptionalString(coverImageUrlRaw);

    const summaryOrDescription0 = summary !== undefined ? summary : description;
    // Prevent wiping required field: if provided, description must be non-empty.
    if (summaryOrDescription0 !== undefined && (summaryOrDescription0 === null || _isBlankString(String(summaryOrDescription0)))) {
      return res.status(400).json({ ok: false, success: false, message: 'Summary (description) cannot be empty' });
    }

    const locationBody = (requestBody.location && typeof requestBody.location === 'object' && !Array.isArray(requestBody.location))
      ? requestBody.location
      : {};
    const loc = _locationSlugsFromValues({
      state: locationBody.state ?? requestBody.state,
      district: locationBody.district ?? requestBody.district,
      city: locationBody.city ?? requestBody.city,
    });

    let scheduled = scheduledAt;
    if (scheduled) {
      const dt = new Date(scheduled);
      scheduled = isNaN(dt) ? undefined : dt;
    }

    const allowedStatuses = new Set(['draft', 'scheduled', 'published', 'archived', 'deleted']);
    if (status !== undefined && status !== null && String(status).trim() !== '' && !allowedStatuses.has(String(status).toLowerCase())) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid status' });
    }

    let before = null;
    try {
      before = await News.findById(rawId)
        .select('title description content translations translationStatus translationError translationNextRetryAt translationUpdatedAt category status workflowStage translationGroupId sourceArticleId originalLang lang language slugs coverImage coverImageUrl imageURL syncVersion')
        .lean();
    } catch (_) {
      // ignore
    }

    const langFromPayload = normalizeLanguage(language);
    const inferredLang = inferLanguageFromDocText({
      title: title !== undefined ? title : before?.title,
      description: (summaryOrDescription0 !== undefined ? summaryOrDescription0 : before?.description),
      content: (content !== undefined ? content : (bodyText !== undefined ? bodyText : before?.content)),
    });
    const effectiveLang0 = langFromPayload || normalizeLanguage(before?.lang || before?.language) || 'en';
    const effectiveLang = (
      (langFromPayload && langFromPayload !== 'en')
        ? langFromPayload
        : (inferredLang && inferredLang !== 'en')
          ? inferredLang
          : effectiveLang0
    );

    // If description is missing in the update payload AND the existing doc is missing it too,
    // fall back to a stripped excerpt of content/body (<= 180 chars).
    let summaryOrDescription = summaryOrDescription0;
    const beforeDesc = before && before.description !== undefined ? String(before.description || '') : '';
    const beforeDescBlank = _isBlankString(beforeDesc);
    const contentWasProvided = (content !== undefined || bodyText !== undefined);
    if (summaryOrDescription === undefined && beforeDescBlank && contentWasProvided) {
      const excerpt = _excerptFromRichText(content ?? bodyText ?? '', 180);
      if (excerpt) summaryOrDescription = excerpt;
    }

    // On update: if slug is provided, use it. Otherwise if title is updated, regenerate slug for that language.
    const resolvedSlug = slug !== undefined
      ? normalizeSlug(slug)
      : (title !== undefined ? slugifyFromTitle(title) : undefined);

    if (resolvedSlug !== undefined) {
      if (!resolvedSlug) {
        return res.status(400).json({ ok: false, success: false, message: 'Slug cannot be empty' });
      }
      await assertSlugUnique(resolvedSlug, rawId);
    }

    const resolvedCoverImageUrl = coverImageUrl ?? imageURL;

    const coverObj = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
    const prevCover = (() => {
      const v = before && before.coverImage;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      const u = before && (before.coverImageUrl || before.imageURL);
      return u ? { url: u, publicId: null, alt: null } : null;
    })();
    let nextCover = null;
    if (coverObj) {
      nextCover = {
        url: prevCover && prevCover.url ? String(prevCover.url) : null,
        publicId: prevCover && prevCover.publicId ? String(prevCover.publicId) : null,
        alt: prevCover && prevCover.alt ? String(prevCover.alt) : null,
      };
      if (coverObj.url !== undefined) nextCover.url = absolutizeUploadsUrl(coverObj.url);
      if (coverObj.publicId !== undefined) nextCover.publicId = coverObj.publicId ? String(coverObj.publicId) : null;
      if (coverObj.alt !== undefined) nextCover.alt = coverObj.alt ? String(coverObj.alt) : null;
    }

    const tagsArr = tags !== undefined
      ? ensureTrackTag(parseTags(tags), sharedSyncFields.track !== undefined ? sharedSyncFields.track : before?.track)
      : (sharedSyncFields.track !== undefined ? ensureTrackTag(before?.tags || [], sharedSyncFields.track) : null);
    const geo = tagsArr ? _geoFromTags(tagsArr) : null;

    const beforeBaseLang = normalizeLanguage(before?.originalLang || before?.lang || before?.language) || 'en';
    const shouldFixMislabel = Boolean((!langFromPayload || langFromPayload === 'en') && inferredLang && inferredLang !== 'en' && beforeBaseLang === 'en');

    const update = {
      ...(title !== undefined ? { title } : {}),
      ...(summaryOrDescription !== undefined ? { description: String(summaryOrDescription).trim() } : {}),
      ...(content !== undefined || bodyText !== undefined ? { content: content ?? bodyText ?? '' } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(sharedSyncFields.track !== undefined ? { track: sharedSyncFields.track } : {}),
      ...((language !== undefined || shouldFixMislabel) ? { language: effectiveLang, lang: effectiveLang, originalLang: effectiveLang } : {}),
      ...(loc.state !== undefined ? { 'location.state': loc.state, 'location.stateSlug': loc.stateSlug ?? null } : {}),
      ...(loc.district !== undefined ? { 'location.district': loc.district, 'location.districtSlug': loc.districtSlug ?? null } : {}),
      ...(loc.city !== undefined ? { 'location.city': loc.city, 'location.citySlug': loc.citySlug ?? null } : {}),
      ...(tagsArr ? { tags: tagsArr, geo } : {}),
      ...(status !== undefined && status !== null && String(status).trim() !== '' ? { status: String(status).toLowerCase() } : {}),
      ...(scheduled !== undefined ? { scheduledAt: scheduled } : {}),
      ...(imageURL !== undefined ? { imageURL } : {}),
      ...(coverImageUrl !== undefined ? { coverImageUrl: absolutizeUploadsUrl(coverImageUrl) } : {}),
      ...(resolvedCoverImageUrl !== undefined && coverImageUrl === undefined ? { coverImageUrl: absolutizeUploadsUrl(resolvedCoverImageUrl) } : {}),
      ...(resolvedCoverImageUrl !== undefined && imageURL === undefined ? { imageURL: resolvedCoverImageUrl } : {}),
      ...(nextCover ? {
        coverImage: nextCover,
        ...(nextCover.url ? {
          // keep legacy fields in sync for older clients
          coverImageUrl: nextCover.url,
          ...(imageURL === undefined ? { imageURL: nextCover.url } : {}),
        } : {}),
      } : {}),
      ...(resolvedSlug !== undefined ? { slug: resolvedSlug, [`slugs.${effectiveLang}`]: resolvedSlug } : {}),
      ...sharedSyncFields,
      ...sponsoredArticleFields.value,
    };

    // Defensive: remove any accidental undefined keys before updates.
    _stripUndefinedKeysInPlace(update);

    const beforeStatusNorm = String(before && before.status ? before.status : '').toLowerCase();
    const nextStatusNorm = update.status ? String(update.status).toLowerCase() : '';
    const isPublishingNow = beforeStatusNorm !== 'published' && nextStatusNorm === 'published';
    const shouldTreatAsSyncSource = _isSourceTranslationDoc(before, rawId);

    // Publish must never block on translation. Translation runs asynchronously after we persist the publish.
    if (isPublishingNow) {
      if (!before) {
        return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
      }

      const now = new Date();
      const stage = mapStatusToWorkflowStage('published');
      const actor = getActor(req);
      const prevStage = String(before.workflowStage || 'DRAFT');

      // Ensure translationGroupId exists (do not rely on doc mutation to avoid accidental overwrites).
      const translationGroupId = String(before.translationGroupId || '').trim() || new mongoose.Types.ObjectId().toString();

      const baseLang = normalizeLanguage(update.lang || update.language || before.lang || before.language) || 'en';
      const baseTitle = update.title !== undefined ? update.title : (before.title || '');
      const baseSummary = update.description !== undefined ? update.description : (before.description || '');
      const baseContent = update.content !== undefined ? update.content : (before.content || '');
      const pending = buildPublishTranslationState({
        baseLang,
        title: baseTitle,
        summary: baseSummary,
        content: baseContent,
        existing: before,
        now,
      });
      const syncMetadata = shouldTreatAsSyncSource
        ? prepareSourceSyncMetadata({
            ...before,
            ...update,
            _id: rawId,
            translationGroupId,
            lang: baseLang,
            language: baseLang,
            originalLang: baseLang,
            status: 'published',
            publishedAt: now,
            translations: pending.translations,
            translationStatus: pending.translationStatus,
          }, { now })
        : {};

      const updateOp = {
        $set: {
          ...update,
          ...syncMetadata,
          translationGroupId,
          // Align publish timestamps similarly to the dedicated publish endpoint.
          status: 'published',
          deletedAt: null,
          publishedAt: now,
          publishAt: null,
          scheduledAt: null,
          // Mark translations pending for non-base languages.
          translations: pending.translations,
          translationStatus: pending.translationStatus,
          translationError: pending.translationError,
          translationNextRetryAt: pending.translationNextRetryAt,
          // Keep workflow stage aligned.
          workflowStage: stage,
          workflowUpdatedAt: now,
        },
        $push: {
          workflowHistory: {
            at: now,
            byUserId: actor.byUserId,
            byRole: actor.byRole,
            action: 'MOVE_STAGE',
            fromStage: prevStage,
            toStage: stage,
            note: 'Status updated',
          },
        },
      };

      const doc = await News.findByIdAndUpdate(rawId, updateOp, { new: true, runValidators: true });
      if (!doc) {
        return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
      }
      await syncArticleFromNews(doc);
      await syncMasterArticleGroup(doc, { reason: 'article_update_publish', invalidate: true });

      // Fire-and-forget: never await translation in the request.
      enqueueTranslateAndSave(doc._id, { logger: console });

      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      invalidateArticleCaches().catch(() => {});
      return res.json({
        ok: true,
        success: true,
        status: 200,
        message: 'Article updated',
        data: { article: withCoverImageUrl(obj) },
        article: withCoverImageUrl(obj),
      });
    }

    // Auto-tag National articles with state/UT slugs based on title+summary+content.
    // Recompute when text fields or category changes; clear tags when category is explicitly set to non-national.
    const nextCategory = category !== undefined
      ? String(category || '').trim().toLowerCase()
      : String(before?.category || '').trim().toLowerCase();
    const willBeNational = _isNationalCategory(nextCategory);
    const shouldRetag = willBeNational && (
      category !== undefined || title !== undefined || summaryOrDescription !== undefined || content !== undefined || bodyText !== undefined
    );
    if (shouldRetag) {
      const nextTitle = title !== undefined ? title : (before?.title || '');
      const nextSummary = summaryOrDescription !== undefined ? String(summaryOrDescription).trim() : (before?.description || '');
      const nextContent = (content !== undefined || bodyText !== undefined)
        ? (content ?? bodyText ?? '')
        : (before?.content || '');
      const tagged = _computeNationalStateTags({ title: nextTitle, summary: nextSummary, content: nextContent });
      update.stateTags = tagged.stateTags;
      update.stateNames = tagged.stateNames;
    } else if (category !== undefined && !willBeNational) {
      update.stateTags = [];
      update.stateNames = [];
    }

    if (shouldTreatAsSyncSource) {
      const now = new Date();
      const syncMetadata = prepareSourceSyncMetadata({
        ...before,
        ...update,
        _id: rawId,
        translations: before?.translations,
        translationStatus: before?.translationStatus,
        translationError: before?.translationError,
        translationNextRetryAt: before?.translationNextRetryAt,
        translationUpdatedAt: before?.translationUpdatedAt,
      }, { now });
      Object.assign(update, syncMetadata);
    }

    const updateKeys = Object.keys(update);
    const META_ONLY_KEYS = new Set(['status', 'scheduledAt', 'publishAt', 'publishedAt', 'deletedAt', 'syncMode', 'sourceArticleId', 'sourceLanguage', 'lastSyncedAt', 'syncVersion', 'contentFingerprint']);
    const isMetaOnlyUpdate = updateKeys.length > 0 && updateKeys.every((k) => META_ONLY_KEYS.has(k));

    let didMetaOnlyUpdate = false;
    let doc = null;
    try {
      if (isMetaOnlyUpdate && nextStatusNorm !== 'published') {
        // Meta-only status/schedule updates: avoid full schema validation.
        const actor = getActor(req);
        const now = new Date();
        const stage = update.status ? mapStatusToWorkflowStage(update.status) : null;
        const beforeStage = String(before?.workflowStage || 'DRAFT');
        const updateOp = { $set: { ...update } };

        if (stage && beforeStage !== stage) {
          updateOp.$set.workflowStage = stage;
          updateOp.$set.workflowUpdatedAt = now;
          updateOp.$push = {
            workflowHistory: {
              at: now,
              byUserId: actor.byUserId,
              byRole: actor.byRole,
              action: 'MOVE_STAGE',
              fromStage: beforeStage,
              toStage: stage,
              note: 'Status updated',
            },
          };
        }

        doc = await News.findByIdAndUpdate(rawId, updateOp, { new: true, runValidators: false });
        didMetaOnlyUpdate = !!doc;
      } else {
        // Full edit update: apply only $set fields (never replace the document).
        doc = await News.findByIdAndUpdate(rawId, { $set: { ...update } }, { new: true, runValidators: true });
        if (doc) {
          // Keep slugs aligned with current titles/translations.
          ensureNewsSlugs(doc);
          doc = await News.findByIdAndUpdate(rawId, { $set: { slug: doc.slug, slugs: doc.slugs } }, { new: true, runValidators: false });
        }
      }
    } catch (err) {
      if (err && err.name === 'ValidationError') {
        return res.status(400).json({ ok: false, success: false, status: 400, message: err.message || 'Validation failed' });
      }
      throw err;
    }

    // Keep the public Article copy in sync when editing already-published CMS News.
    // (Draft/scheduled edits should not affect the public site.)
    if (doc && String(doc.status || '').toLowerCase() === 'published') {
      await syncArticleFromNews(doc);
    }
    if (!doc) {
      // Fallback: some admin builds operate on the public Article model instead of News.
      const allowedArticleStatuses = new Set(['draft', 'published']);

      let articleBefore = null;
      try {
        articleBefore = await PublicArticle.findById(rawId).select('title summary content category track tags').lean();
      } catch (_) {
        // ignore
      }

      const nextArticleCategory = category !== undefined
        ? String(category || '').trim().toLowerCase()
        : String(articleBefore?.category || '').trim().toLowerCase();
      const willBeNationalArticle = _isNationalCategory(nextArticleCategory);
      const shouldRetagArticle = willBeNationalArticle && (
        category !== undefined || title !== undefined || summary !== undefined || content !== undefined || bodyText !== undefined
      );

      const articleUpdate = {
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(content !== undefined || bodyText !== undefined ? { content: content ?? bodyText ?? '' } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(sharedSyncFields.track !== undefined ? { track: sharedSyncFields.track } : {}),
        ...(language !== undefined ? { language: normalizeLanguage(language) || undefined } : {}),
        ...(tagsArr ? { tags: tagsArr, geo } : {}),
        ...(status !== undefined && status !== null && String(status).trim() !== '' && allowedArticleStatuses.has(String(status).toLowerCase())
          ? { status: String(status).toLowerCase() }
          : {}),
        ...(resolvedSlug !== undefined ? { slug: resolvedSlug, [`slugs.${effectiveLang}`]: resolvedSlug } : {}),
        ...sponsoredArticleFields.value,
      };

      if (shouldRetagArticle) {
        const nextTitle = title !== undefined ? title : (articleBefore?.title || '');
        const nextSummary = summary !== undefined ? summary : (articleBefore?.summary || '');
        const nextContent = (content !== undefined || bodyText !== undefined)
          ? (content ?? bodyText ?? '')
          : (articleBefore?.content || '');
        const tagged = _computeNationalStateTags({ title: nextTitle, summary: nextSummary, content: nextContent });
        articleUpdate.stateTags = tagged.stateTags;
        articleUpdate.stateNames = tagged.stateNames;
      } else if (category !== undefined && !willBeNationalArticle) {
        articleUpdate.stateTags = [];
        articleUpdate.stateNames = [];
      }

      // coverImage (preferred) + legacy coverImageUrl/imageURL -> coverImage.url
      const nextCoverForArticle = (() => {
        const coverObj2 = (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) ? coverImage : null;
        const urlFromLegacy = resolvedCoverImageUrl !== undefined ? absolutizeUploadsUrl(resolvedCoverImageUrl) : null;

        if (!coverObj2 && urlFromLegacy === null) return null;

        const out = { url: null, publicId: null, alt: null };
        if (coverObj2) {
          if (coverObj2.url !== undefined) out.url = absolutizeUploadsUrl(coverObj2.url);
          if (coverObj2.publicId !== undefined) out.publicId = coverObj2.publicId ? String(coverObj2.publicId) : null;
          if (coverObj2.alt !== undefined) out.alt = coverObj2.alt ? String(coverObj2.alt) : null;
        }

        if (out.url === null && urlFromLegacy) out.url = urlFromLegacy;
        return out;
      })();

      if (nextCoverForArticle) {
        articleUpdate.coverImage = nextCoverForArticle;
      }

      // Strip undefined fields so we don't unset enums accidentally.
      for (const k of Object.keys(articleUpdate)) {
        if (articleUpdate[k] === undefined) delete articleUpdate[k];
      }

      let articleDoc = null;
      try {
        articleDoc = await PublicArticle.findByIdAndUpdate(rawId, { $set: articleUpdate }, { new: true, runValidators: true });
      } catch (e) {
        // Duplicate slug unique index
        if (e && (e.code === 11000 || e.code === 11001)) {
          return res.status(409).json({ ok: false, success: false, message: 'Slug already exists' });
        }
        throw e;
      }

      if (!articleDoc) {
        return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
      }

      const obj2 = articleDoc.toObject ? articleDoc.toObject({ virtuals: true }) : articleDoc;
      invalidateArticleCaches().catch(() => {});
      return res.json({
        ok: true,
        success: true,
        status: 200,
        message: 'Article updated',
        data: { article: withCoverImageUrl(obj2) },
        article: withCoverImageUrl(obj2),
      });
    }

    // Meta-only updates are intentionally returned early to avoid later full-document validation.
    if (didMetaOnlyUpdate) {
      if (doc && String(doc.status || '').toLowerCase() === 'published') {
        await syncArticleFromNews(doc);
      }
      await syncMasterArticleGroup(doc, {
        reason: 'article_update_meta_only',
        invalidate: ['published', 'scheduled', 'archived', 'deleted'].includes(String(doc?.status || '').toLowerCase()),
      });
      const obj0 = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      invalidateArticleCaches().catch(() => {});
      return res.json({
        ok: true,
        success: true,
        status: 200,
        message: 'Article updated',
        data: { article: withCoverImageUrl(obj0) },
        article: withCoverImageUrl(obj0),
      });
    }

    // Ensure other language slugs are kept in sync when translations exist.
    ensureNewsSlugs(doc);
    await doc.save({ validateModifiedOnly: true });
    // If status changed, keep workflow stage aligned (non-breaking)
    if (update.status) {
      const stage = mapStatusToWorkflowStage(update.status);
      if (doc.workflowStage !== stage) {
        const actor = getActor(req);
        const now = new Date();
        const prevStage = String(doc.workflowStage || 'DRAFT');
        doc.workflowStage = stage;
        doc.workflowUpdatedAt = now;
        doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
        doc.workflowHistory.push({
          at: now,
          byUserId: actor.byUserId,
          byRole: actor.byRole,
          action: 'MOVE_STAGE',
          fromStage: prevStage,
          toStage: stage,
          note: 'Status updated',
        });
        ensureNewsSlugs(doc);
        await doc.save({ validateModifiedOnly: true });
      }
    }

    await syncMasterArticleGroup(doc, {
      reason: 'article_update',
      invalidate: ['published', 'scheduled', 'archived', 'deleted'].includes(String(doc.status || '').toLowerCase()),
    });

    if (String(doc.status || '').toLowerCase() === 'published') {
      await syncArticleFromNews(doc);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;

    invalidateArticleCaches().catch(() => {});

    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article updated',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (err) {
    try { console.error('ArticleUpdate error:', err); } catch (_) {}
    if (err?.status === 409) {
      return res.status(409).json({ ok: false, success: false, message: err.message || 'Slug already exists' });
    }
    return next(err);
  }
});

// POST /api/articles/:id/publish → publish now (Founder only)
router.post('/articles/:id/publish', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const missing = validatePublishable(doc);
    if (missing.length) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: `Missing required fields: ${missing.join(', ')}` });
    }
    await assertSlugUnique(normalizeSlug(doc.slug), id);

    const now = new Date();
    doc.status = 'published';
    doc.deletedAt = null;
    doc.publishedAt = now;
    doc.publishAt = null;
    doc.scheduledAt = null;
    ensureTranslationGroupIdForDoc(doc);
    const currentBase = normalizeLanguage(doc.originalLang) || normalizeLanguage(doc.lang) || normalizeLanguage(doc.language) || 'en';
    const inferredBase = inferLanguageFromDocText({ title: doc.title, description: doc.description, content: doc.content });
    const resolvedBase = (currentBase !== 'en') ? currentBase : (inferredBase || currentBase);
    doc.originalLang = resolvedBase;
    doc.lang = resolvedBase;
    doc.language = resolvedBase;

    // Publish must never block on translation.
    // Mark translations pending for non-base languages and translate asynchronously.
    markPublishTranslationPending(doc);
    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
    }

    ensureNewsSlugs(doc);

    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.workflowStage = 'PUBLISHED';
    doc.workflowUpdatedAt = now;
    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'PUBLISH',
      fromStage,
      toStage: 'PUBLISHED',
      note: null,
    });

    await doc.save();

    await syncArticleFromNews(doc);
    await syncMasterArticleGroup(doc, { reason: 'article_publish', invalidate: true });

    // Legacy safety net:
    // Ensure any existing public copies reachable by slug/slugs.* are marked published
    // and have geo.* populated from News location slugs.
    try {
      const groupKey = String(doc.translationKey || doc.translationGroupId || '').trim();
      const slugs = new Set();
      if (doc.slug) slugs.add(String(doc.slug).trim());
      const slugsObj = doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs) ? doc.slugs : null;
      for (const k of ['en', 'hi', 'gu']) {
        const v = slugsObj && slugsObj[k] ? String(slugsObj[k]).trim() : '';
        if (v) slugs.add(v);
      }
      const slugList = Array.from(slugs).filter(Boolean);

      const or = [];
      if (slugList.length) {
        or.push({ slug: { $in: slugList } });
        or.push({ 'slugs.en': { $in: slugList } });
        or.push({ 'slugs.hi': { $in: slugList } });
        or.push({ 'slugs.gu': { $in: slugList } });
      }
      if (groupKey) {
        or.push({ translationKey: groupKey });
        or.push({ translationGroupId: groupKey });
      }

      const geoState = doc?.geo?.state ?? doc?.location?.stateSlug;
      const geoDistrict = doc?.geo?.district ?? doc?.location?.districtSlug;
      const geoCity = doc?.geo?.city ?? doc?.location?.citySlug;
      const geoSet = {
        ...(geoState ? { 'geo.state': geoState } : {}),
        ...(geoDistrict ? { 'geo.district': geoDistrict } : {}),
        ...(geoCity ? { 'geo.city': geoCity } : {}),
      };

      if (or.length) {
        await PublicArticle.updateMany(
          { $or: or },
          { $set: { status: 'published', deletedAt: null, publishedAt: now, category: doc.category, ...geoSet } },
          { runValidators: false }
        );
      }
    } catch (e) {
      console.warn('[articles.publish] public legacy publish fallback failed', e?.message || e);
    }

    // Fire-and-forget background translation.
    enqueueTranslateAndSave(doc._id, { logger: console });

    // Phase 2: enqueue translations on publish.
    // Translation queue/review system removed.

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'publish',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'publish', oldStatus: 'draft', newStatus: 'published', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    invalidateArticleCaches().catch(() => {});
    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article published',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (e) {
    if (e?.status === 409) return res.status(409).json({ ok: false, success: false, status: 409, message: e.message || 'Slug already exists' });
    console.error('[articles.publish] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to publish article' });
  }
});

// POST /api/admin/articles/:id/retry-translation?lang=hi|gu|en|all
// Backward compatible: if lang is omitted, defaults to all.
router.post('/articles/:id/retry-translation', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid id' });
    }

    const langParam = normalizeRetryLang(req.query.lang);
    if (!langParam) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Missing/invalid lang (use hi, gu, en, or all)' });
    }

    const before = await News.findById(id)
      .select('title description content translationGroupId sourceArticleId syncVersion lang language originalLang translationStatus translationError translationNextRetryAt translationUpdatedAt translations slug slugs status')
      .lean();
    if (!before) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const baseLang = normalizeLanguage(before.originalLang) || normalizeLanguage(before.lang || before.language) || 'en';
    const targets = langParam === 'all' ? ['en', 'hi', 'gu'] : [langParam];
    const now = new Date();

    const translationGroupId = String(before.translationGroupId || '').trim() || new mongoose.Types.ObjectId().toString();

    const set = {
      translationGroupId,
      originalLang: baseLang,
      [`translationStatus.${baseLang}`]: 'ready',
      [`translationError.${baseLang}`]: null,
      [`translationNextRetryAt.${baseLang}`]: null,
      [`translationUpdatedAt.${baseLang}`]: now,
      [`translations.${baseLang}.title`]: String(before.title || '').trim(),
      [`translations.${baseLang}.summary`]: String(before.description || '').trim(),
      [`translations.${baseLang}.content`]: String(before.content || '').trim(),
      [`translations.${baseLang}.provider`]: 'manual',
      [`translations.${baseLang}.generatedAt`]: now,
    };

    for (const t of targets) {
      if (t === baseLang) continue;
      set[`translationStatus.${t}`] = 'pending';
      set[`translationError.${t}`] = null;
      set[`translationNextRetryAt.${t}`] = null;
      set[`translationUpdatedAt.${t}`] = now;
      set[`translations.${t}.title`] = '';
      set[`translations.${t}.summary`] = '';
      set[`translations.${t}.content`] = '';
      set[`translations.${t}.provider`] = 'google';
      set[`translations.${t}.generatedAt`] = null;
    }

    if (_isSourceTranslationDoc(before, id)) {
      Object.assign(set, prepareSourceSyncMetadata({
        ...before,
        _id: id,
        originalLang: baseLang,
        lang: baseLang,
        language: baseLang,
        translationGroupId,
        translationStatus: { ...(before.translationStatus || {}), ...Object.fromEntries(targets.map((t) => [t, t === baseLang ? 'ready' : 'pending'])) },
      }, { now }));
    }

    const doc = await News.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: false });
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    await syncArticleFromNews(doc);
  await syncMasterArticleGroup(doc, { reason: 'article_retry_translation', invalidate: String(doc.status || '').toLowerCase() === 'published' });
    enqueueTranslateAndSave(doc._id, { logger: console });

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    return res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Translation retry queued',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (e) {
    console.error('[articles.retry-translation] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to retry translation' });
  }
});

// POST /api/articles/:id/unpublish → back to draft/archived (Founder only)
router.post('/articles/:id/unpublish', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw !== 'founder') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const toStatus = String(req.body?.toStatus || 'draft').toLowerCase();
    if (!['draft', 'archived'].includes(toStatus)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid toStatus (use draft or archived)' });
    }

    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const now = new Date();
    const actor = getActor(req);
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = toStatus;
    doc.publishedAt = null;
    doc.publishAt = null;
    doc.scheduledAt = null;
    doc.workflowStage = toStatus === 'archived' ? 'ARCHIVED' : 'DRAFT';
    doc.workflowUpdatedAt = now;
    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
    }

    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'UNPUBLISH',
      fromStage,
      toStage: doc.workflowStage,
      note: null,
    });

    await doc.save();
    await syncArticleFromNews(doc);
    await syncMasterArticleGroup(doc, { reason: 'article_unpublish', invalidate: true });

    // Legacy cleanup:
    // Older public Article copies may not be linked via sourceNewsId/translationGroupId.
    // Ensure any public copies reachable by slug/slugs.* are also marked as draft.
    try {
      const slugs = new Set();
      if (doc.slug) slugs.add(String(doc.slug).trim());
      const slugsObj = doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs) ? doc.slugs : null;
      for (const k of ['en', 'hi', 'gu']) {
        const v = slugsObj && slugsObj[k] ? String(slugsObj[k]).trim() : '';
        if (v) slugs.add(v);
      }

      const slugList = Array.from(slugs).filter(Boolean);
      const or = [];
      if (slugList.length) {
        or.push({ slug: { $in: slugList } });
        or.push({ 'slugs.en': { $in: slugList } });
        or.push({ 'slugs.hi': { $in: slugList } });
        or.push({ 'slugs.gu': { $in: slugList } });
      }
      const groupKey = normalizeTranslationGroupKey(doc.translationKey)
        || normalizeTranslationGroupKey(doc.translationGroupId);
      if (groupKey) {
        or.push({ translationKey: groupKey });
        or.push({ translationGroupId: groupKey });
      }

      if (or.length) {
        await PublicArticle.updateMany(
          { $or: or },
          { $set: { status: 'draft', publishedAt: null } },
          { runValidators: false }
        );
      }
    } catch (e) {
      console.warn('[articles.unpublish] public cleanup failed', e?.message || e);
    }

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'unpublish',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'unpublish', oldStatus: 'published', newStatus: toStatus, oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    invalidateArticleCaches().catch(() => {});
    return res.json({ ok: true, success: true, status: 200, message: 'Article unpublished', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    console.error('[articles.unpublish] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to unpublish article' });
  }
});

// POST /api/articles/:id/schedule → set scheduled publish time (Editor/Founder)
router.post('/articles/:id/schedule', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw === 'staff') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const scheduledAtRaw = req.body?.publishAt ?? req.body?.scheduledAt;
    const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
    if (!scheduledAt || isNaN(scheduledAt)) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'publishAt/scheduledAt is required and must be a valid datetime' });
    }

    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const missing = validatePublishable(doc);
    if (missing.length) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: `Missing required fields: ${missing.join(', ')}` });
    }
    await assertSlugUnique(normalizeSlug(doc.slug), id);

    const now = new Date();
    const fromStage = String(doc.workflowStage || 'DRAFT');
    doc.status = 'scheduled';
    doc.scheduledAt = scheduledAt;
    doc.publishAt = scheduledAt;
    doc.publishedAt = null;
    doc.workflowStage = 'SCHEDULED';
    doc.workflowUpdatedAt = now;
    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
    }

    const actor = getActor(req);
    doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
    doc.workflowHistory.push({
      at: now,
      byUserId: actor.byUserId,
      byRole: actor.byRole,
      action: 'MOVE_STAGE',
      fromStage,
      toStage: 'SCHEDULED',
      note: `Scheduled for ${scheduledAt.toISOString()}`,
    });

    await doc.save();
    await syncArticleFromNews(doc);
    await syncMasterArticleGroup(doc, { reason: 'article_schedule', invalidate: true });

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'schedule',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'schedule', oldStatus: 'draft', newStatus: 'scheduled', oldStage: fromStage, newStage: doc.workflowStage, publishAt: scheduledAt.toISOString() },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    invalidateArticleCaches().catch(() => {});
    return res.json({ ok: true, success: true, status: 200, message: 'Article scheduled', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    if (e?.status === 409) return res.status(409).json({ ok: false, success: false, status: 409, message: e.message || 'Slug already exists' });
    console.error('[articles.schedule] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to schedule article' });
  }
});

// POST /api/articles/:id/archive → archive (Editor/Founder)
router.post('/articles/:id/archive', requireAdminAuth, async (req, res) => {
  try {
    const roleRaw = (req.admin && req.admin.role) ? String(req.admin.role).toLowerCase() : 'admin';
    if (roleRaw === 'staff') {
      return res.status(403).json({ ok: false, success: false, status: 403, message: 'Forbidden' });
    }

    const { id } = req.params;
    const before = await News.findById(id).select('workflowStage slug title coverImage coverImageUrl imageURL').lean();
    if (!before) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    const now = new Date();
    const fromStage = String(before.workflowStage || 'DRAFT');
    const actor = getActor(req);

    const doc = await News.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'archived',
          workflowStage: 'ARCHIVED',
          workflowUpdatedAt: now,
        },
        $push: {
          workflowHistory: {
            at: now,
            byUserId: actor.byUserId,
            byRole: actor.byRole,
            action: 'MOVE_STAGE',
            fromStage,
            toStage: 'ARCHIVED',
            note: null,
          },
        },
      },
      { new: true, runValidators: false }
    );
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });

    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
      await doc.save({ validateModifiedOnly: true });
    }

    await syncArticleFromNews(doc);
    await syncMasterArticleGroup(doc, { reason: 'article_archive', invalidate: true });
    await markPublicCopiesDraftFromNewsDoc(doc);

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'archive',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'archive', oldStatus: 'draft', newStatus: 'archived', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    invalidateArticleCaches().catch(() => {});
    return res.json({ ok: true, success: true, status: 200, message: 'Article archived', data: { article: withCoverImageUrl(obj) }, article: withCoverImageUrl(obj) });
  } catch (e) {
    console.error('[articles.archive] error:', e?.message || e);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to archive article' });
  }
});

// DELETE /api/articles/:id → soft delete (CMS/admin)
router.delete('/articles/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const before = await News.findById(id).select('workflowStage slug title coverImage coverImageUrl imageURL').lean();
    if (!before) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    const now = new Date();
    const fromStage = String(before.workflowStage || 'DRAFT');
    const actor = getActor(req);

    const doc = await News.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'deleted',
          deletedAt: now,
          workflowStage: 'REJECTED',
          workflowUpdatedAt: now,
        },
        $push: {
          workflowHistory: {
            at: now,
            byUserId: actor.byUserId,
            byRole: actor.byRole,
            action: 'REJECT',
            fromStage,
            toStage: 'REJECTED',
            note: 'Deleted',
          },
        },
      },
      { new: true, runValidators: false }
    );

    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }

    if (_isSourceTranslationDoc(doc)) {
      Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
      await doc.save({ validateModifiedOnly: true });
    }

    await syncArticleFromNews(doc);
    await syncMasterArticleGroup(doc, { reason: 'article_delete', invalidate: true });
    await markPublicCopiesDraftFromNewsDoc(doc);

    try {
      await PushHistory.create({
        articleId: doc._id,
        type: 'publish',
        action: 'delete',
        slug: doc.slug,
        title: doc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId,
        status: 'SUCCESS',
        meta: { source: 'delete', oldStatus: 'draft', newStatus: 'deleted', oldStage: fromStage, newStage: doc.workflowStage },
      });
    } catch (e) {
      console.warn('[pushHistory] create failed', e?.message || e);
    }

    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
    invalidateArticleCaches().catch(() => {});
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'Article deleted',
      data: { article: withCoverImageUrl(obj) },
      article: withCoverImageUrl(obj),
    });
  } catch (err) {
    console.error('[articles.delete] error:', err?.message || err);
    return res
      .status(500)
      .json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// DELETE /api/articles/:id/permanent → permanent delete (CMS/admin)
// No schema validation (physical delete).
router.delete('/articles/:id/permanent', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await News.findByIdAndDelete(id);
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.permanent-delete] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// DELETE /api/articles/:id/hard-delete → permanent delete (only if already deleted)
router.delete('/articles/:id/hard-delete', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await News.findById(id);
    } catch (_) {
      // invalid ObjectId
    }
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    }
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard-delete] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// DELETE /api/admin/articles/:id/forever → permanent delete (admin only; only if already deleted)
// NOTE: This router is mounted at multiple base paths; we enforce admin auth at the route level.
router.delete('/articles/:id/forever', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try {
      doc = await Article.findById(id);
    } catch (_) {
      // invalid ObjectId
    }

    if (!doc) return res.status(404).json({ success: false, message: 'Article not found' });
    if (String(doc.status || '') !== 'deleted') {
      return res.status(400).json({ success: false, message: 'Only deleted articles can be permanently removed.' });
    }

    await Article.deleteOne({ _id: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[articles.forever-delete] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/admin/articles/forever/bulk → bulk permanent delete (admin only; deletes only status='deleted')
router.post('/articles/forever/bulk', requireAdminAuth, async (req, res) => {
  try {
    const rawIds = req.body && req.body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ success: false, message: 'ids is required' });
    }

    const ids = rawIds
      .map((v) => String(v || '').trim())
      .filter(Boolean);

    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'ids is required' });
    }

    for (const id of ids) {
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'Invalid id in ids' });
      }
    }

    const result = await Article.deleteMany({
      _id: { $in: ids },
      status: 'deleted',
    });

    const deletedCount = Number(result && typeof result.deletedCount === 'number' ? result.deletedCount : 0);
    return res.status(200).json({ success: true, deletedCount });
  } catch (err) {
    console.error('[articles.forever-delete.bulk] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /api/admin/articles/forever/all-deleted → delete ALL soft-deleted articles (admin only)
router.delete('/articles/forever/all-deleted', requireAdminAuth, async (req, res) => {
  try {
    const result = await Article.deleteMany({ status: 'deleted' });
    const deletedCount = Number(result && typeof result.deletedCount === 'number' ? result.deletedCount : 0);
    return res.status(200).json({ success: true, deletedCount });
  } catch (err) {
    console.error('[articles.forever-delete.all-deleted] error:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST alias: /api/articles/:id/hard-delete (admin panel fallback)
router.post('/articles/:id/hard-delete', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try { doc = await News.findById(id); } catch (_) {}
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard-delete.post] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

// POST alias: /api/articles/:id/hard (shorter legacy path)
router.post('/articles/:id/hard', async (req, res) => {
  try {
    const { id } = req.params;
    let doc = null;
    try { doc = await News.findById(id); } catch (_) {}
    if (!doc) return res.status(404).json({ ok: false, success: false, status: 404, message: 'Article not found' });
    const isDeleted = String(doc.status || '').toLowerCase() === 'deleted' || doc.isDeleted === true;
    if (!isDeleted) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Only deleted articles can be permanently removed.' });
    }
    await News.deleteOne({ _id: id });
    return res.status(200).json({ ok: true, success: true, status: 200, message: 'Article permanently deleted.' });
  } catch (err) {
    console.error('[articles.hard.post] error:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
  }
});

module.exports = router;
