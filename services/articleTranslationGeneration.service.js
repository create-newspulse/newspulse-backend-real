const mongoose = require('mongoose');
const News = require('../models/News');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const TranslationJob = require('../models/TranslationJob');
const { slugifyUnicode } = require('../lib/slug');
const { invalidateArticleCaches, invalidateArticleLanguageCaches } = require('../lib/cache');
const googleTranslation = require('./googleTranslationService');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];
const JOB_TYPE = 'article-translation-generate';

function canWriteTranslationJob() {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return false;
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test' && !mongoose.connection.db) return false;
  return true;
}

function normalizeLang(value) {
  return googleTranslation.normalizeLang(value);
}

function normalizeLanguageList(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  const out = [];
  const seen = new Set();
  for (const value of source) {
    const lang = normalizeLang(value);
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);
    out.push(lang);
  }
  return out;
}

async function getEnabledPublicLanguages() {
  try {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test' && (!mongoose.connection || mongoose.connection.readyState !== 1)) {
      return SUPPORTED_LANGS.slice();
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const langs = settings?.published?.languageTheme?.languages;
    const normalized = normalizeLanguageList(langs);
    return normalized.length ? normalized : SUPPORTED_LANGS.slice();
  } catch (_) {
    return SUPPORTED_LANGS.slice();
  }
}

function detectScriptLanguage(docLike) {
  const text = [docLike?.title, docLike?.description, docLike?.summary, docLike?.content].map((v) => String(v || '')).join('\n');
  const gu = (text.match(/[\u0A80-\u0AFF]/g) || []).length;
  const hi = (text.match(/[\u0900-\u097F]/g) || []).length;
  if (gu >= 3 && gu >= hi) return 'gu';
  if (hi >= 3 && hi > gu) return 'hi';
  return null;
}

async function resolveSourceLanguage(docLike, options = {}) {
  const explicit = normalizeLang(options.sourceLanguage || docLike?.sourceLanguage || docLike?.lang || docLike?.language || docLike?.originalLang);
  if (explicit) return { lang: explicit, detected: false };
  const script = detectScriptLanguage(docLike);
  if (script) return { lang: script, detected: true };
  const detected = await googleTranslation.detectLanguage([docLike?.title, docLike?.description, docLike?.content].join('\n')).catch(() => null);
  if (detected?.ok && detected.lang) return { lang: detected.lang, detected: true };
  return { lang: 'en', detected: true };
}

function sourceHashForDoc(docLike) {
  return googleTranslation.stableHash(JSON.stringify({
    title: docLike?.title || '',
    summary: docLike?.description || docLike?.summary || '',
    content: docLike?.content || '',
    imageAltText: docLike?.coverImage?.alt || docLike?.imageAltText || '',
    seoTitle: docLike?.seo?.metaTitle || docLike?.seoTitle || '',
    metaDescription: docLike?.seo?.metaDescription || docLike?.metaDescription || '',
    socialDescription: docLike?.seo?.socialDescription || docLike?.socialDescription || '',
    imageCaption: docLike?.coverImage?.caption || docLike?.imageCaption || '',
  }));
}

function buildExistingQuery(groupKey, lang, excludeId) {
  const q = {
    $and: [
      { $or: [{ translationGroupId: groupKey }, { translationKey: groupKey }] },
      { $or: [{ language: lang }, { lang }] },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
    ],
  };
  if (excludeId) q._id = { $ne: excludeId };
  return q;
}

function pickSourceObject(docLike) {
  return docLike && typeof docLike.toObject === 'function' ? docLike.toObject({ virtuals: true }) : { ...(docLike || {}) };
}

async function translateOptionalField(value, sourceLang, targetLang, format = 'text') {
  const raw = String(value ?? '');
  if (!raw.trim()) return { ok: true, text: raw };
  return googleTranslation.translateText(raw, sourceLang, targetLang, { format });
}

async function translateArticleFields(source, sourceLang, targetLang) {
  const fields = {};
  const failures = [];
  const map = [
    ['title', source.title, 'text'],
    ['description', source.description || source.summary || '', 'text'],
    ['content', source.content || '', 'html'],
    ['imageAltText', source.coverImage?.alt || source.imageAltText || '', 'text'],
    ['seoTitle', source.seo?.metaTitle || source.seoTitle || '', 'text'],
    ['metaDescription', source.seo?.metaDescription || source.metaDescription || '', 'text'],
    ['socialDescription', source.seo?.socialDescription || source.socialDescription || '', 'text'],
    ['imageCaption', source.coverImage?.caption || source.imageCaption || '', 'text'],
  ];

  for (const [key, value, format] of map) {
    const res = await translateOptionalField(value, sourceLang, targetLang, format);
    if (!res.ok) failures.push({ field: key, error: res.error || 'Translation failed' });
    fields[key] = res.ok ? res.text : String(value || '');
  }
  return { ok: failures.length === 0, fields, failures };
}

function buildTranslatedPayload(source, translated, { targetLang, sourceLang, groupKey, sourceHash, jobId, requestedBy }) {
  const slugs = source.slugs && typeof source.slugs === 'object' && !Array.isArray(source.slugs) ? { ...source.slugs } : {};
  const targetSlug = slugs[targetLang] || source.slug || slugifyUnicode(translated.title || source.title || 'article');
  slugs[targetLang] = targetSlug;

  const coverImage = source.coverImage && typeof source.coverImage === 'object' ? { ...source.coverImage } : undefined;
  if (coverImage && translated.imageAltText) coverImage.alt = translated.imageAltText;

  const seo = source.seo && typeof source.seo === 'object' ? { ...source.seo } : {};
  if (translated.seoTitle) seo.metaTitle = translated.seoTitle;
  if (translated.metaDescription) seo.metaDescription = translated.metaDescription;
  if (translated.socialDescription) seo.socialDescription = translated.socialDescription;

  return {
    title: translated.title || source.title,
    description: translated.description || source.description || source.summary,
    content: translated.content || source.content || '',
    category: source.category,
    editorialType: source.editorialType,
    track: source.track,
    tags: Array.isArray(source.tags) ? source.tags : [],
    stateTags: Array.isArray(source.stateTags) ? source.stateTags : [],
    stateNames: Array.isArray(source.stateNames) ? source.stateNames : [],
    topic: source.topic,
    location: source.location,
    geo: source.geo,
    imageURL: source.imageURL,
    coverImageUrl: source.coverImageUrl,
    ...(coverImage ? { coverImage } : {}),
    externalUrls: Array.isArray(source.externalUrls) ? source.externalUrls : [],
    embeds: Array.isArray(source.embeds) ? source.embeds : [],
    gallery: Array.isArray(source.gallery) ? source.gallery : [],
    seo,
    slug: targetSlug,
    slugs,
    lang: targetLang,
    language: targetLang,
    originalLang: targetLang,
    sourceLanguage: sourceLang,
    translationKey: groupKey,
    translationGroupId: groupKey,
    sourceArticleId: source._id,
    syncMode: 'auto',
    status: 'draft',
    publishedAt: null,
    publishAt: null,
    scheduledAt: null,
    deletedAt: null,
    workflowStage: 'DRAFT',
    machineGenerated: true,
    humanEdited: false,
    translationReviewStatus: 'review_required',
    translatedAt: new Date(),
    translatedByProvider: 'google_translate',
    sourceHash,
    translationJobId: jobId || null,
    translationMeta: {
      provider: 'google_translate',
      sourceArticleId: source._id,
      sourceLanguage: sourceLang,
      sourceHash,
      targetLanguage: targetLang,
      machineGenerated: true,
      humanEdited: false,
      translatedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      requestedBy: requestedBy || null,
    },
  };
}

async function upsertJob(sourceDoc, { sourceLanguage, targetLanguages, sourceHash, requestedBy }) {
  try {
    const id = sourceDoc?._id;
    if (!id || !mongoose.isValidObjectId(String(id))) return null;
    if (!canWriteTranslationJob()) return null;
    return await TranslationJob.findOneAndUpdate(
      { type: JOB_TYPE, newsId: id },
      {
        $set: {
          status: 'translating',
          provider: 'google_translate',
          sourceLanguage,
          targetLanguages,
          sourceHash,
          startedAt: new Date(),
          completedAt: null,
          failureReason: null,
          lastError: null,
          requestedBy: requestedBy || null,
        },
        $inc: { attempts: 1, retryCount: 1 },
        $setOnInsert: { runAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (_) {
    return null;
  }
}

async function finishJob(job, status, result, failureReason) {
  if (!job?._id) return;
  try {
    await TranslationJob.findByIdAndUpdate(job._id, {
      $set: {
        status,
        result,
        failureReason: failureReason || null,
        lastError: failureReason || null,
        completedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  } catch (_) {}
}

async function ensureSourceGroup(sourceDoc, groupKey) {
  if (!sourceDoc || !groupKey) return;
  if (String(sourceDoc.translationGroupId || '') === groupKey && String(sourceDoc.translationKey || '') === groupKey) return;
  try {
    if (typeof sourceDoc.set === 'function' && typeof sourceDoc.save === 'function') {
      sourceDoc.set({ translationGroupId: groupKey, translationKey: groupKey });
      await sourceDoc.save({ validateModifiedOnly: true });
    } else if (sourceDoc._id) {
      await News.updateOne({ _id: sourceDoc._id }, { $set: { translationGroupId: groupKey, translationKey: groupKey } });
    }
  } catch (_) {}
}

function actorLabel(req) {
  const actor = req?.admin || req?.user || null;
  return actor?.email || actor?.id || actor?.role || null;
}

async function generateArticleTranslations(sourceDocInput, options = {}) {
  const sourceDoc = sourceDocInput && typeof sourceDocInput.then === 'function' ? await sourceDocInput : sourceDocInput;
  if (!sourceDoc) return { ok: false, status: 'failed', message: 'Article not found' };

  const source = pickSourceObject(sourceDoc);
  const sourceLanguage = (await resolveSourceLanguage(source, options)).lang;
  const enabledLanguages = normalizeLanguageList(options.targetLanguages).length
    ? normalizeLanguageList(options.targetLanguages)
    : await getEnabledPublicLanguages();
  const targetLanguages = enabledLanguages.filter((lang) => lang !== sourceLanguage);
  const groupKey = String(source.translationGroupId || source.translationKey || new mongoose.Types.ObjectId().toString()).trim();
  const sourceHash = sourceHashForDoc(source);
  const requestedBy = options.requestedBy || actorLabel(options.req);
  const overwrite = Boolean(options.overwrite);
  const allowHumanOverwrite = Boolean(options.confirmOverwriteHumanEdited || options.founderConfirmed);

  await ensureSourceGroup(sourceDoc, groupKey);
  const job = await upsertJob(source, { sourceLanguage, targetLanguages, sourceHash, requestedBy });

  const created = {};
  const updated = {};
  const skipped = {};
  const failed = {};

  for (const targetLang of targetLanguages) {
    const existing = await News.findOne(buildExistingQuery(groupKey, targetLang, source._id));
    if (existing && existing.humanEdited && !(overwrite && allowHumanOverwrite)) {
      skipped[targetLang] = { reason: 'human_edited', id: String(existing._id) };
      continue;
    }
    if (existing && !overwrite) {
      skipped[targetLang] = { reason: 'exists', id: String(existing._id) };
      continue;
    }

    const translated = await translateArticleFields(source, sourceLanguage, targetLang);
    if (!translated.ok) {
      failed[targetLang] = translated.failures;
      continue;
    }

    const payload = buildTranslatedPayload(source, translated.fields, {
      targetLang,
      sourceLang: sourceLanguage,
      groupKey,
      sourceHash,
      jobId: job?._id || null,
      requestedBy,
    });

    if (existing) {
      const doc = await News.findByIdAndUpdate(existing._id, { $set: payload }, { new: true, runValidators: true });
      updated[targetLang] = String(doc?._id || existing._id);
    } else {
      const doc = await News.create(payload);
      created[targetLang] = String(doc?._id || '');
    }

    await invalidateArticleLanguageCaches(payload.slug).catch(() => null);
  }

  const completedCount = Object.keys(created).length + Object.keys(updated).length;
  const failedCount = Object.keys(failed).length;
  const status = failedCount && completedCount ? 'partially_completed' : (failedCount ? 'failed' : 'review_required');
  const result = { sourceLanguage, targetLanguages, translationGroupId: groupKey, created, updated, skipped, failed };
  await finishJob(job, status, result, failedCount ? 'One or more translations failed' : null);
  await invalidateArticleCaches().catch(() => null);

  return { ok: failedCount === 0, status, provider: 'google_translate', sourceLanguage, targetLanguages, sourceHash, translationGroupId: groupKey, created, updated, skipped, failed, jobId: job?._id ? String(job._id) : null };
}

async function enqueueArticleTranslationGeneration(sourceDocInput, options = {}) {
  const source = pickSourceObject(sourceDocInput);
  if (!source?._id) return null;
  const sourceLanguage = (await resolveSourceLanguage(source, options)).lang;
  const enabledLanguages = await getEnabledPublicLanguages();
  const targetLanguages = enabledLanguages.filter((lang) => lang !== sourceLanguage);
  const sourceHash = sourceHashForDoc(source);
  return upsertJob(source, { sourceLanguage, targetLanguages, sourceHash, requestedBy: options.requestedBy || null });
}

async function markSiblingTranslationsOutdated(sourceDocInput, options = {}) {
  if (!canWriteTranslationJob()) return { modifiedCount: 0 };
  const source = pickSourceObject(sourceDocInput);
  const groupKey = String(source?.translationGroupId || source?.translationKey || '').trim();
  if (!groupKey || !source?._id) return { modifiedCount: 0 };
  const sourceLanguage = normalizeLang(source.language || source.lang || source.originalLang);
  const filter = {
    $and: [
      { $or: [{ translationGroupId: groupKey }, { translationKey: groupKey }] },
      { _id: { $ne: source._id } },
      { machineGenerated: true },
      { humanEdited: { $ne: true } },
    ],
  };
  if (sourceLanguage) filter.$and.push({ $or: [{ language: { $ne: sourceLanguage } }, { lang: { $ne: sourceLanguage } }] });
  return News.updateMany(filter, {
    $set: {
      translationReviewStatus: 'translation_outdated',
      'translationMeta.outdatedAt': new Date(),
      'translationMeta.outdatedReason': options.reason || 'source_updated',
    },
  });
}

async function estimateBackfill(options = {}) {
  const max = Math.max(1, Math.min(Number(options.maxCount || options.limit || 25), 500));
  const filter = {};
  if (options.onlyPublished) filter.status = 'published';
  if (Array.isArray(options.articleIds) && options.articleIds.length) filter._id = { $in: options.articleIds };
  const docs = await News.find(filter).select('_id title description content lang language originalLang translationGroupId translationKey').limit(max).lean();
  const estimatedCharacterCount = (docs || []).reduce((sum, doc) => sum + String(doc.title || '').length + String(doc.description || '').length + String(doc.content || '').length, 0);
  return { count: docs.length, estimatedArticleCount: docs.length, estimatedCharacterCount, maxCount: max };
}

module.exports = {
  SUPPORTED_LANGS,
  JOB_TYPE,
  normalizeLanguageList,
  getEnabledPublicLanguages,
  resolveSourceLanguage,
  sourceHashForDoc,
  translateArticleFields,
  generateArticleTranslations,
  enqueueArticleTranslationGeneration,
  markSiblingTranslationsOutdated,
  estimateBackfill,
};