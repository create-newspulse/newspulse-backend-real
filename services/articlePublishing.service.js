const mongoose = require('mongoose');

const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { canonicalizeSlug, getSlugCandidates, slugifyUnicode } = require('../lib/slug');
const { invalidateArticleCaches } = require('../lib/cache');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');
const { generateArticleTranslations } = require('./articleTranslationGeneration.service');
const {
  normalizeTranslationGroupKey,
  prepareSourceSyncMetadata,
} = require('./translationGroupSync.service');
const {
  applyPulseDialogueStandardText,
  preparePulseDialogueForPublication,
} = require('./pulseDialogue.service');

const REQUIRED_LANGUAGES = ['en', 'hi', 'gu'];

function normalizeLanguage(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (REQUIRED_LANGUAGES.includes(primary)) return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj' || lettersOnly === 'gj') return 'gu';
  return null;
}

function stripHtmlForLangDetect(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ');
}

function countUnicodeMatches(value, regex) {
  const matches = String(value || '').match(regex);
  return matches ? matches.length : 0;
}

function inferLanguageFromDocText({ title, description, content } = {}) {
  const text = stripHtmlForLangDetect(`${title || ''} ${description || ''} ${content || ''}`);
  if (!text.trim()) return null;
  const guCount = countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const min = 12;
  if (guCount >= min && guCount > hiCount) return 'gu';
  if (hiCount >= min && hiCount > guCount) return 'hi';
  return null;
}

function safeText(value) {
  return String(value ?? '').trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasFullTranslationBucket(bucket) {
  const b = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
  return isNonEmptyString(b.title) && isNonEmptyString(b.summary) && isNonEmptyString(b.content);
}

function getStoredLanguageForArticle(docLike) {
  return normalizeLanguage(docLike?.language) || normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.originalLang) || null;
}

function isSourceTranslationDoc(docLike, fallbackId) {
  const ownId = String(docLike?._id || fallbackId || '').trim();
  const sourceId = String(docLike?.sourceArticleId || '').trim();
  return !sourceId || (ownId && sourceId === ownId);
}

function isActiveTranslationArticle(docLike) {
  const status = String(docLike?.status || '').trim().toLowerCase();
  if (status === 'archived' || status === 'deleted') return false;
  return !docLike?.deletedAt;
}

function getPublishReadyMissingFields(docLike) {
  const missing = [];
  if (!safeText(docLike?.title)) missing.push('title');
  if (!safeText(docLike?.slug)) missing.push('slug');
  if (!safeText(docLike?.category)) missing.push('category');
  if (!getStoredLanguageForArticle(docLike)) missing.push('language');
  if (!safeText(docLike?.description || docLike?.summary)) missing.push('summary');
  if (!safeText(docLike?.content || docLike?.body)) missing.push('content');
  return missing;
}

function getActor(req) {
  const a = req?.admin || req?.user || {};
  return {
    byUserId: a.id || a._id || a.userId || null,
    byRole: a.role || a.adminRole || (a.isFounder ? 'Founder' : 'Admin'),
  };
}

function getTitleForLangFromDocLike(docLike, lang) {
  const desired = normalizeLanguage(lang);
  if (!desired) return '';
  const translated = docLike?.translations?.[desired];
  if (typeof translated?.title === 'string' && translated.title.trim()) return translated.title;
  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || null;
  if (baseLang === desired) return String(docLike?.title || '');
  return '';
}

function ensureNewsSlugs(docLike) {
  if (!docLike) return;
  const slugs = { ...(docLike.slugs || {}) };
  for (const lang of REQUIRED_LANGUAGES) {
    const title = getTitleForLangFromDocLike(docLike, lang);
    if (title && title.trim()) slugs[lang] = slugifyUnicode(title);
  }

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
  if (!slugs[baseLang] && docLike.title) slugs[baseLang] = slugifyUnicode(docLike.title);
  docLike.slugs = slugs;
  if ((!docLike.slug || !String(docLike.slug).trim()) && slugs[baseLang]) docLike.slug = slugs[baseLang];
}

function ensureTranslationGroupIdForDoc(doc) {
  if (!doc) return null;
  const existing = normalizeTranslationGroupKey(doc.translationGroupId) || normalizeTranslationGroupKey(doc.translationKey);
  const groupKey = existing || new mongoose.Types.ObjectId().toString();
  doc.translationGroupId = groupKey;
  doc.translationKey = groupKey;
  return groupKey;
}

async function assertSlugUnique(slug, excludeId) {
  const normalized = canonicalizeSlug(slug);
  if (!normalized) return;
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test'
    && (!mongoose.connection || mongoose.connection.readyState !== 1)) {
    return;
  }
  const candidates = getSlugCandidates(normalized);
  const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
  const query = { slug: slugFilter };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await News.findOne(query).select('_id slug').lean();
  if (existing) {
    const error = new Error('Slug already exists');
    error.statusCode = 409;
    throw error;
  }
}

function snapshotPublishState(doc) {
  return {
    status: doc.status,
    deletedAt: doc.deletedAt,
    publishedAt: doc.publishedAt,
    publishAt: doc.publishAt,
    scheduledAt: doc.scheduledAt,
    workflowStage: doc.workflowStage,
    workflowUpdatedAt: doc.workflowUpdatedAt,
    workflowHistory: Array.isArray(doc.workflowHistory) ? [...doc.workflowHistory] : doc.workflowHistory,
  };
}

function restorePublishState(doc, state) {
  if (!doc || !state) return;
  doc.status = state.status;
  doc.deletedAt = state.deletedAt;
  doc.publishedAt = state.publishedAt;
  doc.publishAt = state.publishAt;
  doc.scheduledAt = state.scheduledAt;
  doc.workflowStage = state.workflowStage;
  doc.workflowUpdatedAt = state.workflowUpdatedAt;
  doc.workflowHistory = state.workflowHistory;
}

function buildTranslationGroupPublishReadiness(groupDocs) {
  const byLang = { en: [], hi: [], gu: [] };
  for (const doc of Array.isArray(groupDocs) ? groupDocs : []) {
    if (!isActiveTranslationArticle(doc)) continue;
    const lang = getStoredLanguageForArticle(doc);
    if (lang && byLang[lang]) byLang[lang].push(doc);
  }

  const missingLanguages = [];
  const duplicateLanguages = [];
  const invalidRecords = [];
  const readyDocs = [];

  for (const lang of REQUIRED_LANGUAGES) {
    const docs = byLang[lang];
    if (!docs.length) {
      missingLanguages.push(lang);
      continue;
    }
    if (docs.length > 1) {
      duplicateLanguages.push(lang);
      continue;
    }
    const doc = docs[0];
    const missingFields = getPublishReadyMissingFields(doc);
    if (missingFields.length) {
      invalidRecords.push({ language: lang, id: doc?._id ? String(doc._id) : null, missingFields });
      continue;
    }
    readyDocs.push(doc);
  }

  return {
    ok: missingLanguages.length === 0 && duplicateLanguages.length === 0 && invalidRecords.length === 0,
    readyDocs,
    missingLanguages,
    duplicateLanguages,
    invalidRecords,
  };
}

async function findTranslationGroupDocs(groupKey) {
  if (!groupKey) return [];
  return News.find({ $or: [{ translationGroupId: groupKey }, { translationKey: groupKey }] });
}

function buildManualTranslationSibling(sourceDoc, targetLang, groupKey, actor) {
  const bucket = sourceDoc?.translations?.[targetLang];
  if (!hasFullTranslationBucket(bucket)) return null;
  const sourceObject = sourceDoc && typeof sourceDoc.toObject === 'function' ? sourceDoc.toObject({ virtuals: true }) : { ...(sourceDoc || {}) };
  const slugs = sourceObject.slugs && typeof sourceObject.slugs === 'object' && !Array.isArray(sourceObject.slugs)
    ? { ...sourceObject.slugs }
    : {};
  slugs[targetLang] = slugs[targetLang] || slugifyUnicode(bucket.title || sourceObject.title || 'article');
  const coverImage = sourceObject.coverImage && typeof sourceObject.coverImage === 'object' && !Array.isArray(sourceObject.coverImage)
    ? { ...sourceObject.coverImage }
    : undefined;
  const pulseDialogue = sourceObject.pulseDialogue
    ? applyPulseDialogueStandardText(sourceObject.pulseDialogue, targetLang)
    : undefined;

  return {
    title: safeText(bucket.title),
    description: safeText(bucket.summary),
    content: safeText(bucket.content),
    category: sourceObject.category,
    editorialType: sourceObject.editorialType,
    track: sourceObject.track,
    tags: Array.isArray(sourceObject.tags) ? sourceObject.tags : [],
    stateTags: Array.isArray(sourceObject.stateTags) ? sourceObject.stateTags : [],
    stateNames: Array.isArray(sourceObject.stateNames) ? sourceObject.stateNames : [],
    topic: sourceObject.topic,
    location: sourceObject.location,
    geo: sourceObject.geo,
    imageURL: sourceObject.imageURL,
    coverImageUrl: sourceObject.coverImageUrl,
    ...(coverImage ? { coverImage } : {}),
    externalUrls: Array.isArray(sourceObject.externalUrls) ? sourceObject.externalUrls : [],
    embeds: Array.isArray(sourceObject.embeds) ? sourceObject.embeds : [],
    gallery: Array.isArray(sourceObject.gallery) ? sourceObject.gallery : [],
    seo: sourceObject.seo,
    pulseDialogue,
    slug: slugs[targetLang],
    slugs,
    lang: targetLang,
    language: targetLang,
    originalLang: targetLang,
    sourceLanguage: getStoredLanguageForArticle(sourceDoc) || 'en',
    translationKey: groupKey,
    translationGroupId: groupKey,
    sourceArticleId: sourceObject._id,
    syncMode: 'auto',
    status: 'draft',
    publishedAt: null,
    publishAt: null,
    scheduledAt: null,
    deletedAt: null,
    workflowStage: 'DRAFT',
    machineGenerated: false,
    humanEdited: true,
    translationReviewStatus: 'reviewed',
    translatedAt: bucket.generatedAt || new Date(),
    translatedByProvider: bucket.provider || 'manual',
    translationMeta: {
      provider: bucket.provider || 'manual',
      sourceArticleId: sourceObject._id,
      sourceLanguage: getStoredLanguageForArticle(sourceDoc) || 'en',
      targetLanguage: targetLang,
      machineGenerated: false,
      humanEdited: true,
      translatedAt: bucket.generatedAt || new Date(),
      reviewedAt: new Date(),
      reviewedBy: actor?.byUserId || actor?.byRole || null,
    },
  };
}

async function createSiblingsFromCachedTranslations(sourceDoc, missingLanguages, groupKey, actor) {
  const created = [];
  for (const lang of missingLanguages) {
    const payload = buildManualTranslationSibling(sourceDoc, lang, groupKey, actor);
    if (!payload) continue;
    const existing = await News.findOne({
      $and: [
        { $or: [{ translationGroupId: groupKey }, { translationKey: groupKey }] },
        { $or: [{ language: lang }, { lang }] },
        { status: { $ne: 'deleted' } },
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      ],
    }).select('_id').lean();
    if (existing) continue;
    const doc = await News.create(payload);
    created.push(doc);
  }
  return created;
}

async function ensureRequiredTranslations(sourceDoc, groupKey, actor, options = {}) {
  let groupDocs = await findTranslationGroupDocs(groupKey);
  let readiness = buildTranslationGroupPublishReadiness(groupDocs);
  const generated = { created: {}, updated: {}, skipped: {}, failed: {} };

  if (readiness.missingLanguages.length) {
    await createSiblingsFromCachedTranslations(sourceDoc, readiness.missingLanguages, groupKey, actor);
    groupDocs = await findTranslationGroupDocs(groupKey);
    readiness = buildTranslationGroupPublishReadiness(groupDocs);
  }

  if (readiness.missingLanguages.length) {
    await saveDoc(sourceDoc, { validateModifiedOnly: true });
    const translationResult = await generateArticleTranslations(sourceDoc, {
      req: options.req,
      targetLanguages: REQUIRED_LANGUAGES,
      overwrite: false,
      requestedBy: actor?.byUserId ? String(actor.byUserId) : actor?.byRole,
    });
    Object.assign(generated, {
      created: translationResult.created || {},
      updated: translationResult.updated || {},
      skipped: translationResult.skipped || {},
      failed: translationResult.failed || {},
    });
    if (!translationResult.ok) {
      const error = new Error('Failed to generate required translations');
      error.statusCode = 502;
      error.details = { translationResult };
      throw error;
    }
    groupDocs = await findTranslationGroupDocs(groupKey);
    readiness = buildTranslationGroupPublishReadiness(groupDocs);
  }

  if (!readiness.ok) {
    const error = new Error('English, Hindi and Gujarati versions must be completed before publishing.');
    error.statusCode = readiness.duplicateLanguages.length ? 409 : 400;
    error.details = {
      translationGroupId: groupKey,
      missingLanguages: readiness.missingLanguages,
      duplicateLanguages: readiness.duplicateLanguages,
      invalidRecords: readiness.invalidRecords,
      generated,
    };
    throw error;
  }

  return { readiness, generated };
}

async function syncPublicFallbacks(doc, now, logger = console) {
  try {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test'
      && (!mongoose.connection || !mongoose.connection.db)) {
      return;
    }
    const groupKey = String(doc.translationKey || doc.translationGroupId || '').trim();
    const slugs = new Set();
    if (doc.slug) slugs.add(String(doc.slug).trim());
    const slugsObj = doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs) ? doc.slugs : null;
    for (const lang of REQUIRED_LANGUAGES) {
      const value = slugsObj && slugsObj[lang] ? String(slugsObj[lang]).trim() : '';
      if (value) slugs.add(value);
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
    if (!or.length) return;

    const geoState = doc?.geo?.state ?? doc?.location?.stateSlug;
    const geoDistrict = doc?.geo?.district ?? doc?.location?.districtSlug;
    const geoCity = doc?.geo?.city ?? doc?.location?.citySlug;
    await PublicArticle.updateMany(
      { $or: or },
      {
        $set: {
          status: 'published',
          deletedAt: null,
          publishedAt: now,
          category: doc.category,
          ...(geoState ? { 'geo.state': geoState } : {}),
          ...(geoDistrict ? { 'geo.district': geoDistrict } : {}),
          ...(geoCity ? { 'geo.city': geoCity } : {}),
        },
      },
      { runValidators: false }
    );
  } catch (error) {
    logger.warn?.('[articles.publish] public legacy publish fallback failed', error?.message || error);
  }
}

async function saveDoc(doc, options) {
  if (typeof doc.save === 'function') return doc.save(options);
  return doc;
}

async function rollbackPublishedDocs(previous) {
  for (const item of previous) restorePublishState(item.doc, item.state);
  for (const item of previous) {
    try {
      await saveDoc(item.doc);
      await syncPublicArticleFromNews(item.doc).catch(() => null);
    } catch (_) {}
  }
}

async function publishCanonicalArticle(articleIdOrDoc, options = {}) {
  const req = options.req || null;
  const actor = options.actor || getActor(req);
  const logger = options.logger || console;
  const requestedId = typeof articleIdOrDoc === 'object' && articleIdOrDoc !== null ? articleIdOrDoc._id : articleIdOrDoc;
  const sourceDoc = typeof articleIdOrDoc === 'object' && articleIdOrDoc !== null
    ? articleIdOrDoc
    : await News.findById(articleIdOrDoc);

  if (!sourceDoc) {
    const error = new Error('Article not found');
    error.statusCode = 404;
    throw error;
  }

  const id = String(requestedId || sourceDoc._id || '').trim();
  if (id && mongoose.Types.ObjectId.isValid(id) === false) {
    const error = new Error('Invalid id');
    error.statusCode = 400;
    throw error;
  }

  const missing = getPublishReadyMissingFields(sourceDoc);
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    error.details = { missingFields: missing };
    throw error;
  }
  await assertSlugUnique(sourceDoc.slug, sourceDoc._id);

  const groupKey = ensureTranslationGroupIdForDoc(sourceDoc);
  const currentBase = normalizeLanguage(sourceDoc.originalLang) || normalizeLanguage(sourceDoc.lang) || normalizeLanguage(sourceDoc.language) || 'en';
  const inferredBase = inferLanguageFromDocText({ title: sourceDoc.title, description: sourceDoc.description, content: sourceDoc.content });
  const resolvedBase = currentBase !== 'en' ? currentBase : (inferredBase || currentBase);
  sourceDoc.originalLang = resolvedBase;
  sourceDoc.lang = resolvedBase;
  sourceDoc.language = resolvedBase;
  ensureNewsSlugs(sourceDoc);
  if (isSourceTranslationDoc(sourceDoc)) Object.assign(sourceDoc, prepareSourceSyncMetadata(sourceDoc, { now: new Date() }));

  const { readiness, generated } = await ensureRequiredTranslations(sourceDoc, groupKey, actor, { req });
  const now = options.now instanceof Date ? options.now : new Date();
  const previous = readiness.readyDocs.map((doc) => ({ doc, state: snapshotPublishState(doc) }));
  const changedDocs = [];

  try {
    for (const doc of readiness.readyDocs) {
      const lang = getStoredLanguageForArticle(doc);
      const wasPublished = String(doc.status || '').toLowerCase() === 'published' && doc.publishedAt;
      if (lang) {
        doc.language = lang;
        doc.lang = lang;
        if (!normalizeLanguage(doc.originalLang)) doc.originalLang = lang;
      }
      doc.status = 'published';
      doc.deletedAt = null;
      doc.publishedAt = wasPublished ? doc.publishedAt : now;
      doc.publishAt = null;
      doc.scheduledAt = null;
      doc.workflowStage = 'PUBLISHED';
      doc.workflowUpdatedAt = wasPublished && doc.workflowUpdatedAt ? doc.workflowUpdatedAt : now;
      doc.workflowHistory = Array.isArray(doc.workflowHistory) ? doc.workflowHistory : [];
      if (!wasPublished) {
        changedDocs.push(doc);
        doc.workflowHistory.push({
          at: now,
          byUserId: actor.byUserId,
          byRole: actor.byRole,
          action: options.groupPublish ? 'PUBLISH_GROUP' : 'PUBLISH',
          fromStage: previous.find((item) => item.doc === doc)?.state?.workflowStage || null,
          toStage: 'PUBLISHED',
          note: options.reason || req?.body?.reason || null,
        });
      }
      ensureNewsSlugs(doc);
      await preparePulseDialogueForPublication(doc);
      if (isSourceTranslationDoc(doc)) Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
      await saveDoc(doc);
    }

    for (const doc of readiness.readyDocs) {
      await syncPublicArticleFromNews(doc, { logger });
      await syncPublicFallbacks(doc, now, logger);
    }
  } catch (error) {
    await rollbackPublishedDocs(previous);
    throw error;
  }

  const sourcePublishedDoc = readiness.readyDocs.find((doc) => String(doc._id || '') === String(sourceDoc._id || '')) || sourceDoc;
  if (changedDocs.length) {
    try {
      await PushHistory.create({
        articleId: sourcePublishedDoc._id,
        type: 'publish',
        action: 'publish',
        slug: sourcePublishedDoc.slug,
        title: sourcePublishedDoc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId && mongoose.Types.ObjectId.isValid(String(actor.byUserId)) ? actor.byUserId : null,
        status: 'SUCCESS',
        meta: {
          source: options.source || 'publish',
          oldStatus: previous.find((item) => item.doc === sourcePublishedDoc)?.state?.status || null,
          newStatus: 'published',
          oldStage: previous.find((item) => item.doc === sourcePublishedDoc)?.state?.workflowStage || null,
          newStage: sourcePublishedDoc.workflowStage,
          publishedLanguages: readiness.readyDocs.map((doc) => getStoredLanguageForArticle(doc)).filter(Boolean),
        },
      });
    } catch (error) {
      logger.warn?.('[pushHistory] create failed', error?.message || error);
    }
  }

  invalidateArticleCaches().catch(() => {});

  return {
    ok: true,
    statusCode: 200,
    message: options.groupPublish ? 'Translation group published' : 'Article published',
    translationGroupId: groupKey,
    publishedLanguages: readiness.readyDocs.map((doc) => getStoredLanguageForArticle(doc)).filter(Boolean),
    articles: readiness.readyDocs,
    article: sourcePublishedDoc,
    generated,
    changed: changedDocs.length > 0,
  };
}

module.exports = {
  REQUIRED_LANGUAGES,
  publishCanonicalArticle,
  buildTranslationGroupPublishReadiness,
  getPublishReadyMissingFields,
};