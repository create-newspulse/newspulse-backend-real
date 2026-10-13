const mongoose = require('mongoose');
const News = require('../models/News');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const TranslationJob = require('../models/TranslationJob');
const { slugifyUnicode } = require('../lib/slug');
const { invalidateArticleLanguageCaches } = require('../lib/cache');
const googleTranslation = require('./googleTranslationService');
const { applyPulseDialogueStandardText } = require('./pulseDialogue.service');
const { sponsoredArticleFields } = require('./syncPublicArticleFromNews.service');
const { withActiveArticleSource, afterArticleCommit } = require('./articleLifecycle.service');
const { assertArticleSlugsUnique } = require('./articleSlugUniqueness.service');
const { syncTranslationGroupMetadata } = require('./translationGroupSync.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');

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
  const localizedSlug = slugifyUnicode(translated.title || source.title || 'article');
  const targetSlug = slugs[targetLang]
    || (localizedSlug === source.slug ? `${localizedSlug}-${targetLang}` : localizedSlug);
  slugs[targetLang] = targetSlug;

  const coverImage = source.coverImage && typeof source.coverImage === 'object' ? { ...source.coverImage } : undefined;
  if (coverImage && translated.imageAltText) coverImage.alt = translated.imageAltText;

  const seo = source.seo && typeof source.seo === 'object' ? { ...source.seo } : {};
  if (translated.seoTitle) seo.metaTitle = translated.seoTitle;
  if (translated.metaDescription) seo.metaDescription = translated.metaDescription;
  if (translated.socialDescription) seo.socialDescription = translated.socialDescription;

  const pulseDialogue = source.pulseDialogue
    ? applyPulseDialogueStandardText(source.pulseDialogue, targetLang)
    : undefined;

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
    ...sponsoredArticleFields(source),
    pulseDialogue,
    ...(source.authorByline !== undefined ? { authorByline: source.authorByline } : {}),
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

async function upsertJob(sourceDoc, { sourceLanguage, targetLanguages, sourceHash, requestedBy }, session) {
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
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  );
}

async function finishJob(job, status, result, failureReason, session) {
  if (!job?._id) return;
  await TranslationJob.findByIdAndUpdate(job._id, {
    $set: {
      status,
      result,
      failureReason: failureReason || null,
      lastError: failureReason || null,
      completedAt: new Date(),
      finishedAt: new Date(),
    },
  }, { session });
}

async function ensureSourceGroup(sourceDoc, groupKey, session) {
  if (String(sourceDoc.translationGroupId || '') === groupKey && String(sourceDoc.translationKey || '') === groupKey) return;
  await News.updateOne({ _id: sourceDoc._id }, {
    $set: { translationGroupId: groupKey, translationKey: groupKey },
  }, { session });
}

function assertCurrentSource(source, groupKey, sourceHash) {
  const currentGroup = source.translationGroupId || source.translationKey;
  if ((currentGroup && String(currentGroup) !== groupKey) || sourceHashForDoc(source) !== sourceHash) {
    throw Object.assign(new Error('The source story changed. Translation was cancelled; retry with the current edition.'), {
      statusCode: 409, code: 'TRANSLATION_SOURCE_CHANGED',
    });
  }
}

function skippedTranslation(existing, overwrite, allowHumanOverwrite) {
  if (!existing) return null;
  if (existing.status === 'deleted' || existing.deletedAt) {
    throw Object.assign(new Error('Restore the translation group before generating translations.'), { statusCode: 409 });
  }
  if (existing.humanEdited && !(overwrite && allowHumanOverwrite)) return 'human_edited';
  return overwrite ? null : 'exists';
}

function actorLabel(req) {
  const actor = req?.admin || req?.user || null;
  return actor?.email || actor?.id || actor?.role || null;
}

async function generateArticleTranslations(sourceDocInput, options = {}) {
  const sourceDoc = sourceDocInput && typeof sourceDocInput.then === 'function' ? await sourceDocInput : sourceDocInput;
  if (!sourceDoc) return { ok: false, status: 'failed', message: 'Article not found' };

  const source = pickSourceObject(sourceDoc);
  if (source.status === 'deleted' || source.deletedAt) {
    return { ok: false, status: 'failed', message: 'Deleted stories cannot generate translations' };
  }
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

  const job = await withActiveArticleSource(source._id, async (current, session) => {
    assertCurrentSource(current, groupKey, sourceHash);
    await ensureSourceGroup(current, groupKey, session);
    return upsertJob(current, { sourceLanguage, targetLanguages, sourceHash, requestedBy }, session);
  }, options);

  const created = {};
  const updated = {};
  const skipped = {};
  const failed = {};
  const changedPublicDocs = [];
  const changedSlugs = [];

  async function invalidateCommittedTranslations(result) {
    for (const slug of changedSlugs) await afterArticleCommit(options, result, () => invalidateArticleLanguageCaches(slug));
    if (changedPublicDocs.length) await afterArticleCommit(options, result, async () => {
      result.revalidation = await invalidateArticleContent(changedPublicDocs, {
        reason: 'translation_updated', publicVisibilityRemoved: true,
      });
    });
  }

  try {
    for (const targetLang of targetLanguages) {
      const existing = await News.findOne(buildExistingQuery(groupKey, targetLang, source._id), null, { session: options.session });
      const skipReason = skippedTranslation(existing, overwrite, allowHumanOverwrite);
      if (skipReason) {
        skipped[targetLang] = { reason: skipReason, id: String(existing._id) };
        continue;
      }

      const translated = await translateArticleFields(source, sourceLanguage, targetLang);
      if (!translated.ok) {
        failed[targetLang] = translated.failures;
        continue;
      }

      const result = await withActiveArticleSource(source._id, async (currentSource, session) => {
        assertCurrentSource(currentSource, groupKey, sourceHash);
        const current = await News.findOne(buildExistingQuery(groupKey, targetLang, source._id), null, { session });
        const reason = skippedTranslation(current, overwrite, allowHumanOverwrite);
        if (reason) return { skipped: { reason, id: String(current._id) } };
        const payload = buildTranslatedPayload(currentSource, translated.fields, {
          targetLang, sourceLang: sourceLanguage, groupKey, sourceHash,
          jobId: job?._id || null, requestedBy,
        });
        if (current) {
          for (const field of ['status', 'publishedAt', 'publishAt', 'scheduledAt', 'deletedAt', 'workflowStage']) delete payload[field];
          payload.slug = current.slug || payload.slug;
          payload.slugs = { ...payload.slugs, ...current.slugs, [targetLang]: payload.slug };
        }
        await assertArticleSlugsUnique({ ...payload, _id: current?._id }, { session });
        const doc = current
          ? await News.findOneAndUpdate(
            { _id: current._id, status: { $ne: 'deleted' }, deletedAt: null },
            { $set: payload }, { new: true, runValidators: true, session }
          )
          : (await News.create([payload], { session }))[0];
        if (!doc) throw Object.assign(new Error('Translation changed during generation. Retry the operation.'), { statusCode: 409 });
        if (doc.status === 'published') await syncTranslationGroupMetadata(doc, {
          previousDoc: current.toObject(),
          patch: { title: doc.title, description: doc.description, content: doc.content, slug: doc.slug },
          invalidate: false, session,
        });
        return { doc, wasExisting: Boolean(current) };
      }, options);
      if (result.skipped) {
        skipped[targetLang] = result.skipped;
        continue;
      }
      (result.wasExisting ? updated : created)[targetLang] = String(result.doc._id);
      if (result.doc.status === 'published') changedPublicDocs.push(result.doc);
      changedSlugs.push(result.doc.slug);
    }
  } catch (error) {
    console.error('[articleTranslations] transaction failed', { code: error.code || 'TRANSLATION_PERSISTENCE_FAILED' });
    if (!options.session) {
      const partial = { created, updated, skipped, failed };
      await afterArticleCommit(options, partial, () =>
        finishJob(job, 'failed', partial, error.code || 'Translation could not be persisted'));
      await invalidateCommittedTranslations(partial);
      error.details = {
        ...error.details, translationResult: partial,
        ...(Object.keys(created).length || Object.keys(updated).length ? { committed: true } : {}),
      };
    }
    throw error;
  }

  const completedCount = Object.keys(created).length + Object.keys(updated).length;
  const failedCount = Object.keys(failed).length;
  const status = failedCount && completedCount ? 'partially_completed' : (failedCount ? 'failed' : 'review_required');
  const result = { sourceLanguage, targetLanguages, translationGroupId: groupKey, created, updated, skipped, failed };
  const response = { ok: failedCount === 0, status, provider: 'google_translate', sourceLanguage, targetLanguages, sourceHash, translationGroupId: groupKey, created, updated, skipped, failed, jobId: job?._id ? String(job._id) : null };
  const finish = () => finishJob(job, status, result, failedCount ? 'One or more translations failed' : null, options.session);
  if (options.session) await finish();
  else await afterArticleCommit(options, response, finish);
  await invalidateCommittedTranslations(response);
  return response;
}

async function enqueueArticleTranslationGeneration(sourceDocInput, options = {}) {
  const source = pickSourceObject(sourceDocInput);
  if (!source?._id) return null;
  if (!canWriteTranslationJob()) return null;
  const sourceLanguage = (await resolveSourceLanguage(source, options)).lang;
  const enabledLanguages = await getEnabledPublicLanguages();
  const targetLanguages = enabledLanguages.filter((lang) => lang !== sourceLanguage);
  const sourceHash = sourceHashForDoc(source);
  return withActiveArticleSource(source._id, async (current, session) => {
    assertCurrentSource(current, String(source.translationGroupId || source.translationKey || ''), sourceHash);
    return upsertJob(current, { sourceLanguage, targetLanguages, sourceHash, requestedBy: options.requestedBy || null }, session);
  }, options);
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
  }, { session: options.session });
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