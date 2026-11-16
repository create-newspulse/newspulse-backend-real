const mongoose = require('mongoose');
const { prepareAuthorBylineForPublication } = require('./authorByline.service');

const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { slugifyUnicode } = require('../lib/slug');
const { buildArticleCreatorFields } = require('../lib/articleCreator');
const { syncPublicArticleFromNews, sponsoredArticleFields, syncNewsTranslationBuckets } = require('./syncPublicArticleFromNews.service');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');
const { assertArticleSlugsUnique, buildStoryIdentityFilter } = require('./articleSlugUniqueness.service');
const { withActiveArticleSource, buildPublicCopyFilter, afterArticleCommit, inArticleTransaction } = require('./articleLifecycle.service');
const { articlePublicationAuthorizer } = require('./articleSaveAccess.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');
const {
  generateArticleTranslations, findExistingTranslation, resolveRequestTranslationSource,
} = require('./articleTranslationGeneration.service');
const { translationSourceIdentityError } = require('./translationGroupStatus');
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

function isActiveTranslationArticle(docLike) {
  const status = String(docLike?.status || '').trim().toLowerCase();
  if (status === 'deleted') return false;
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
    if (!slugs[lang] && title && title.trim()) slugs[lang] = slugifyUnicode(title);
  }

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
  if (!slugs[baseLang] && docLike.title) slugs[baseLang] = slugifyUnicode(docLike.title);
  docLike.slugs = slugs;
  if ((!docLike.slug || !String(docLike.slug).trim()) && slugs[baseLang]) docLike.slug = slugs[baseLang];
}

function ensureTranslationGroupIdForDoc(doc, verifiedKey) {
  if (!doc) return null;
  const existing = normalizeTranslationGroupKey(verifiedKey)
    || normalizeTranslationGroupKey(doc.translationGroupId) || normalizeTranslationGroupKey(doc.translationKey);
  const groupKey = existing || new mongoose.Types.ObjectId().toString();
  doc.translationGroupId = groupKey;
  doc.translationKey = groupKey;
  return groupKey;
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
    authorByline: doc.authorByline,
  };
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

async function findTranslationGroupDocs(sourceDoc, session) {
  return News.find(buildStoryIdentityFilter(sourceDoc), null, { session });
}

function buildManualTranslationSibling(sourceDoc, targetLang, groupKey, actor, cachedDoc = sourceDoc) {
  const bucket = cachedDoc?.translations?.[targetLang];
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
    ...sponsoredArticleFields(sourceObject),
    pulseDialogue,
    ...(sourceObject.authorByline !== undefined ? { authorByline: sourceObject.authorByline } : {}),
    slug: slugs[targetLang],
    slugs,
    lang: targetLang,
    language: targetLang,
    originalLang: targetLang,
    sourceLanguage: getStoredLanguageForArticle(sourceDoc),
    translationKey: groupKey,
    translationGroupId: groupKey,
    sourceArticleId: sourceDoc._id,
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
      sourceArticleId: sourceDoc._id,
      sourceLanguage: getStoredLanguageForArticle(sourceDoc),
      targetLanguage: targetLang,
      machineGenerated: false,
      humanEdited: true,
      translatedAt: bucket.generatedAt || new Date(),
      reviewedAt: new Date(),
      reviewedBy: actor?.byUserId || actor?.byRole || null,
    },
  };
}

async function createSiblingsFromCachedTranslations(sourceDoc, missingLanguages, groupKey, actor, options) {
  const created = [];
  for (const lang of missingLanguages) {
    const requested = options.requestedEdition || sourceDoc;
    if (!hasFullTranslationBucket(requested.translations?.[lang])
      && !hasFullTranslationBucket(sourceDoc.translations?.[lang])) continue;
    const doc = await withActiveArticleSource(sourceDoc._id, async (current, session) => {
      if (String(current.translationGroupId || current.translationKey) !== groupKey) {
        throw Object.assign(new Error('Translation group changed. Reload and retry.'), { statusCode: 409 });
      }
      const cachedDoc = String(requested._id) === String(current._id) ? current
        : await News.findById(requested._id, null, { session }).lean();
      if (!cachedDoc) throw translationSourceIdentityError('The requested translation edition is missing.');
      const verified = await resolveRequestTranslationSource(cachedDoc, session);
      if (String(verified.source._id) !== String(current._id) || verified.sourceGroupKey !== groupKey) {
        throw translationSourceIdentityError('The translation source changed during publication.');
      }
      const payload = buildManualTranslationSibling(current, lang, groupKey, actor,
        hasFullTranslationBucket(cachedDoc.translations?.[lang]) ? cachedDoc : current);
      if (!payload) return null;
      const existing = await findExistingTranslation(groupKey, lang, current._id, verified.existingEditionIds, session);
      if (existing?.status === 'deleted' || existing?.deletedAt) {
        throw Object.assign(new Error('Restore the translation group before publishing.'), { statusCode: 409 });
      }
      if (existing) return null;
      await assertArticleSlugsUnique(payload, { session });
      return (await News.create([{ ...payload, ...buildArticleCreatorFields(options.req) }], { session }))[0];
    }, options);
    if (doc) created.push(doc);
  }
  return created;
}

async function ensureRequiredTranslations(sourceDoc, groupKey, actor, options = {}) {
  let groupDocs = await findTranslationGroupDocs(sourceDoc, options.session);
  if (groupDocs.some(doc => doc.status === 'deleted' || doc.deletedAt)) {
    throw Object.assign(new Error('Restore the complete translation group before publishing.'), { statusCode: 409 });
  }
  let readiness = buildTranslationGroupPublishReadiness(groupDocs);
  const generated = { created: {}, updated: {}, skipped: {}, failed: {} };

  if (readiness.missingLanguages.length) {
    await createSiblingsFromCachedTranslations(sourceDoc, readiness.missingLanguages, groupKey, actor, options);
    groupDocs = await findTranslationGroupDocs(sourceDoc, options.session);
    readiness = buildTranslationGroupPublishReadiness(groupDocs);
  }

  if (readiness.missingLanguages.length) {
    await saveDoc(sourceDoc, { validateModifiedOnly: true, session: options.session, saveScope: options.saveScope });
    const translationResult = await generateArticleTranslations(sourceDoc, {
      ...options,
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
    groupDocs = await findTranslationGroupDocs(sourceDoc, options.session);
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

async function saveDoc(doc, options = {}) {
  const { saveScope, ...saveOptions } = options;
  saveScope?.assertNewsRecords([doc]);
  saveScope?.bindNewsDocument(doc);
  if (typeof doc.save === 'function') return doc.save(saveOptions);
  return doc;
}

async function publishCanonicalArticle(articleIdOrDoc, options = {}) {
  if (!options.req) return publishArticleInSession(articleIdOrDoc, options);
  const id = typeof articleIdOrDoc === 'object' && articleIdOrDoc !== null ? articleIdOrDoc._id : articleIdOrDoc;
  if (!mongoose.isValidObjectId(String(id || ''))) {
    throw Object.assign(new Error('Invalid article id'), { statusCode: 400 });
  }
  const existing = await News.findById(id, null, { session: options.session });
  if (!existing) throw Object.assign(new Error('Article not found'), { statusCode: 404 });
  const authorizeSave = articlePublicationAuthorizer(options.req);
  return inArticleTransaction(async (session, transaction) => {
    const source = await News.findById(id, null, { session });
    if (!source) throw Object.assign(new Error('Article was removed. Reload and retry.'), { statusCode: 409 });
    const saveScope = await authorizeSave(source, session);
    return publishArticleInSession(source, { ...options, ...transaction, authorizeSave, saveScope });
  }, options);
}

async function publishArticleInSession(articleIdOrDoc, options = {}) {
  const req = options.req || null;
  const actor = options.actor || getActor(req);
  const logger = options.logger || console;
  const requestedId = typeof articleIdOrDoc === 'object' && articleIdOrDoc !== null ? articleIdOrDoc._id : articleIdOrDoc;
  const requestedDoc = options.session || typeof articleIdOrDoc !== 'object'
    ? await News.findById(requestedId, null, { session: options.session })
    : articleIdOrDoc;

  if (!requestedDoc) {
    const error = new Error('Article not found');
    error.statusCode = 404;
    throw error;
  }

  const id = String(requestedDoc._id || requestedId || '').trim();
  if (id && mongoose.Types.ObjectId.isValid(id) === false) {
    const error = new Error('Invalid id');
    error.statusCode = 400;
    throw error;
  }

  const missing = getPublishReadyMissingFields(requestedDoc);
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    error.details = { missingFields: missing };
    throw error;
  }
  if (requestedDoc.status === 'deleted' || requestedDoc.deletedAt) {
    throw Object.assign(new Error('Restore the deleted story before publishing.'), { statusCode: 409 });
  }

  const requested = typeof requestedDoc.toObject === 'function' ? requestedDoc.toObject() : requestedDoc;
  const { source, members, ...identity } = await resolveRequestTranslationSource(requested, options.session);
  if (members.some(doc => doc.status === 'deleted' || doc.deletedAt)) {
    throw Object.assign(new Error('Restore the complete translation group before publishing.'), { statusCode: 409 });
  }
  for (const member of members) await options.authorizeSave?.(member, options.session);
  const sourceDoc = String(source._id) === id ? requestedDoc
    : await News.findById(source._id, null, { session: options.session });
  if (!sourceDoc) throw translationSourceIdentityError('The canonical source article is missing.');
  const sourceMissing = getPublishReadyMissingFields(sourceDoc);
  if (sourceMissing.length) {
    throw Object.assign(new Error(`Missing required fields: ${sourceMissing.join(', ')}`), {
      statusCode: 400, details: { missingFields: sourceMissing },
    });
  }
  const authorizeSource = req ? articlePublicationAuthorizer(req, identity.sourceGroupKey ? {
    translationGroupId: identity.sourceGroupKey, translationKey: identity.sourceGroupKey,
  } : {}) : options.authorizeSave;
  const requestedScope = options.saveScope;
  const saveScope = authorizeSource ? await authorizeSource(sourceDoc, options.session) : options.saveScope;
  options = { ...options, ...identity, saveScope, requestedEdition: requestedDoc };
  const groupKey = ensureTranslationGroupIdForDoc(sourceDoc, identity.sourceGroupKey);
  options.sourceGroupKey = groupKey;
  sourceDoc.originalLang = identity.sourceLanguage;
  sourceDoc.lang = identity.sourceLanguage;
  sourceDoc.language = identity.sourceLanguage;
  ensureNewsSlugs(sourceDoc);
  Object.assign(sourceDoc, prepareSourceSyncMetadata(sourceDoc, { now: new Date() }));
  options.saveScope?.adoptSourceIdentity(sourceDoc);
  options.saveScope?.assertNewsRecords(members.map(doc => String(doc._id) === String(sourceDoc._id)
    ? sourceDoc : { ...doc, sourceArticleId: doc.sourceArticleId || sourceDoc._id }));
  await assertArticleSlugsUnique(sourceDoc, { session: options.session });
  if (String(sourceDoc._id) !== id
    && (requestedDoc.translationGroupId !== groupKey || requestedDoc.translationKey !== groupKey)) {
    ensureTranslationGroupIdForDoc(requestedDoc, groupKey);
    requestedScope?.adoptSourceIdentity(requestedDoc);
    await saveDoc(requestedDoc, { validateModifiedOnly: true, session: options.session, saveScope: requestedScope });
    options.saveScope = authorizeSource ? await authorizeSource(sourceDoc, options.session) : options.saveScope;
    options.saveScope?.adoptSourceIdentity(sourceDoc);
  }
  await saveDoc(sourceDoc, { validateModifiedOnly: true, session: options.session, saveScope: options.saveScope });

  const { generated } = await ensureRequiredTranslations(sourceDoc, groupKey, actor, options);
  const now = options.now instanceof Date ? options.now : new Date();

  const { readiness, previous, changedDocs } = await withActiveArticleSource(sourceDoc._id, async (current, session, transaction) => {
    if (String(current.translationGroupId || current.translationKey) !== groupKey) {
      throw Object.assign(new Error('Translation group changed. Reload and retry.'), { statusCode: 409 });
    }
    const verified = await resolveRequestTranslationSource(current, session);
    if (String(verified.source._id) !== String(sourceDoc._id) || verified.sourceGroupKey !== groupKey) {
      throw translationSourceIdentityError('The translation source changed during publication.');
    }
    const groupDocs = await findTranslationGroupDocs(current, session);
    const saveScope = transaction.saveScope;
    saveScope?.assertNewsRecords(groupDocs);
    const readiness = buildTranslationGroupPublishReadiness(groupDocs);
    if (groupDocs.some(doc => doc.status === 'deleted' || doc.deletedAt) || !readiness.ok
      || !readiness.readyDocs.some(doc => String(doc._id) === id)) {
      throw Object.assign(new Error('The translation group changed. Review every edition before publishing.'), { statusCode: 409 });
    }
    const previous = readiness.readyDocs.map(doc => ({ doc, state: snapshotPublishState(doc) }));
    const changedDocs = [];
    const bylineSource = readiness.readyDocs.find(doc => String(doc._id) === String(sourceDoc._id));
    if (!bylineSource) throw translationSourceIdentityError('The canonical source article is missing.');
    const publicationDate = bylineSource.publishedAt
      || readiness.readyDocs.map(doc => doc.publishedAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0]
      || now;
    await prepareAuthorBylineForPublication(bylineSource, now);
    for (const doc of readiness.readyDocs) {
      if (bylineSource.authorByline !== undefined) doc.authorByline = bylineSource.authorByline;
      Object.assign(doc, sponsoredArticleFields(bylineSource));
      const lang = getStoredLanguageForArticle(doc);
      const wasPublished = String(doc.status || '').toLowerCase() === 'published' && doc.publishedAt;
      if (lang) {
        doc.language = lang;
        doc.lang = lang;
        if (!normalizeLanguage(doc.originalLang)) doc.originalLang = lang;
      }
      doc.status = 'published';
      doc.deletedAt = null;
      doc.publishedAt = doc.publishedAt || publicationDate;
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
      await assertArticleSlugsUnique(doc, { session });
      await preparePulseDialogueForPublication(doc);
      if (String(doc._id) === String(sourceDoc._id)) Object.assign(doc, prepareSourceSyncMetadata(doc, { now }));
      else {
        doc.sourceArticleId = doc.sourceArticleId || sourceDoc._id;
        doc.sourceLanguage = doc.sourceLanguage || identity.sourceLanguage;
      }
      saveScope?.approvePublishedRecord(doc);
      await saveDoc(doc, { session, saveScope });
    }

    await syncNewsTranslationBuckets(readiness.readyDocs, { session, now, saveScope });
    // Only synchronized native copies become public; stale legacy duplicates stay hidden.
    try {
      if (saveScope) await saveScope.hidePublicationCopies(session);
      else {
        const hidden = await PublicArticle.updateMany(
          buildPublicCopyFilter(groupDocs), { $set: { status: 'draft' } }, { session }
        );
        if (!hidden?.acknowledged) throw new Error('Public copy update was not acknowledged');
      }
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 409) throw error;
      logger.warn?.('[articles.publish] public copy visibility update failed', { articleId: String(sourceDoc._id) });
      throw Object.assign(new Error('Public article synchronization failed. Retry the operation.'), {
        status: 503, statusCode: 503, code: 'PUBLIC_ARTICLE_SYNC_FAILED', cause: error,
      });
    }
    const ordered = [...readiness.readyDocs].sort((a, b) =>
      Number(isPubliclyVisibleNewsArticle(a, { now })) - Number(isPubliclyVisibleNewsArticle(b, { now })));
    for (const doc of ordered) {
      await syncPublicArticleFromNews(doc, { logger, groupDocs: readiness.readyDocs, throwOnError: true, session, now, saveScope });
    }
    await saveScope?.verifyPublishedGroup(session, sourceDoc);
    return { readiness, previous, changedDocs };
  }, options);
  for (const doc of readiness.readyDocs) {
    if (typeof doc.$session === 'function') doc.$session(null);
  }

  const requestedPublishedDoc = readiness.readyDocs.find(doc => String(doc._id) === id);
  const result = {
    ok: true,
    statusCode: 200,
    message: options.groupPublish ? 'Translation group published' : 'Article published',
    translationGroupId: groupKey,
    publishedLanguages: readiness.readyDocs.map((doc) => getStoredLanguageForArticle(doc)).filter(Boolean),
    articles: readiness.readyDocs,
    article: requestedPublishedDoc,
    generated,
    changed: changedDocs.length > 0,
    publicSync: { ok: true, failedArticleIds: [] },
  };
  await afterArticleCommit(options, result, async () => {
    if (changedDocs.length) {
    try {
      await PushHistory.create({
        articleId: requestedPublishedDoc._id,
        type: 'publish',
        action: 'publish',
        slug: requestedPublishedDoc.slug,
        title: requestedPublishedDoc.title,
        channel: 'SITE',
        at: now,
        byUserId: actor.byUserId && mongoose.Types.ObjectId.isValid(String(actor.byUserId)) ? actor.byUserId : null,
        status: 'SUCCESS',
        meta: {
          source: options.source || 'publish',
          oldStatus: previous.find((item) => item.doc === requestedPublishedDoc)?.state?.status || null,
          newStatus: 'published',
          oldStage: previous.find((item) => item.doc === requestedPublishedDoc)?.state?.workflowStage || null,
          newStage: requestedPublishedDoc.workflowStage,
          publishedLanguages: readiness.readyDocs.map((doc) => getStoredLanguageForArticle(doc)).filter(Boolean),
        },
      });
    } catch (error) {
      logger.warn?.('[pushHistory] create failed', error?.message || error);
    }
    }
    result.revalidation = await invalidateArticleContent(readiness.readyDocs, {
      previousDocs: options.previousDocs, reason: 'article_publish', publicVisibilityRemoved: true, logger,
    });
  });
  return result;
}

module.exports = {
  REQUIRED_LANGUAGES,
  publishCanonicalArticle,
  buildTranslationGroupPublishReadiness,
  getPublishReadyMissingFields,
};