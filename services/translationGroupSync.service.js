const crypto = require('crypto');

const News = require('../models/News');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');
const {
  buildArticleRevalidationTargets,
  notifyPublicContentInvalidation,
} = require('./publicContentInvalidation.service');
const { slugifyUnicode } = require('../lib/slug');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const lang = raw.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(lang) ? lang : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function normalizeNullableString(value) {
  const text = safeText(value).trim();
  return text || null;
}

function normalizeTranslationGroupKey(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered === 'null' || lowered === 'undefined') return null;
  return text;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeNullableString(item))
    .filter(Boolean);
}

function cloneSimple(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getBaseLanguage(docLike) {
  const doc = isPlainObject(docLike) ? docLike : {};
  return normalizeLang(doc.sourceLanguage)
    || normalizeLang(doc.originalLang)
    || normalizeLang(doc.lang)
    || normalizeLang(doc.language)
    || 'en';
}

function getGroupKey(docLike) {
  const doc = isPlainObject(docLike) ? docLike : {};
  return normalizeTranslationGroupKey(doc.translationGroupId)
    || normalizeTranslationGroupKey(doc.translationKey);
}

function normalizeObjectIdString(value) {
  const normalized = normalizeNullableString(value);
  return normalized || null;
}

function isChildLinkedToMaster(masterDoc, childDoc) {
  const masterId = normalizeObjectIdString(masterDoc?._id);
  const childId = normalizeObjectIdString(childDoc?._id);
  const childSourceId = normalizeObjectIdString(childDoc?.sourceArticleId);

  if (!masterId || !childId || masterId === childId) return false;
  if (!childSourceId) return true;
  return childSourceId === masterId;
}

function hasFullBucket(bucket) {
  const value = isPlainObject(bucket) ? bucket : {};
  return Boolean(
    normalizeNullableString(value.title)
    && normalizeNullableString(value.summary)
    && normalizeNullableString(value.content)
  );
}

function buildSeoObject(seoLike) {
  const seo = isPlainObject(seoLike) ? seoLike : {};
  return {
    metaTitle: normalizeNullableString(seo.metaTitle),
    metaDescription: normalizeNullableString(seo.metaDescription),
    canonicalUrl: normalizeNullableString(seo.canonicalUrl),
  };
}

function computeContentFingerprint(docLike) {
  const doc = isPlainObject(docLike) ? docLike : {};
  const payload = {
    title: safeText(doc.title).trim(),
    description: safeText(doc.description || doc.summary).trim(),
    content: safeText(doc.content).trim(),
    category: safeText(doc.category).trim().toLowerCase(),
    tags: normalizeStringArray(doc.tags),
    geo: cloneSimple(doc.geo || null),
    location: cloneSimple(doc.location || null),
    stateTags: normalizeStringArray(doc.stateTags),
    stateNames: normalizeStringArray(doc.stateNames),
    coverImage: cloneSimple(doc.coverImage || null),
    coverImageUrl: normalizeNullableString(doc.coverImageUrl),
    imageURL: normalizeNullableString(doc.imageURL),
    externalUrls: normalizeStringArray(doc.externalUrls),
    embeds: normalizeStringArray(doc.embeds),
    gallery: normalizeStringArray(doc.gallery),
    seo: buildSeoObject(doc.seo),
    status: safeText(doc.status).trim().toLowerCase(),
    publishedAt: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : null,
    deletedAt: doc.deletedAt ? new Date(doc.deletedAt).toISOString() : null,
    translations: cloneSimple(doc.translations || null),
    translationStatus: cloneSimple(doc.translationStatus || null),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function prepareSourceSyncMetadata(docLike, options = {}) {
  const doc = isPlainObject(docLike) ? docLike : {};
  const now = options.now instanceof Date ? options.now : new Date();
  const currentVersion = Number.isFinite(Number(doc.syncVersion)) ? Number(doc.syncVersion) : 0;
  const nextVersion = options.bumpVersion === false ? Math.max(currentVersion, 1) : currentVersion + 1;
  const baseLang = getBaseLanguage(doc);

  return {
    syncMode: 'auto',
    sourceArticleId: doc._id || null,
    sourceLanguage: baseLang,
    lastSyncedAt: now,
    syncVersion: nextVersion,
    contentFingerprint: computeContentFingerprint({ ...doc, sourceLanguage: baseLang }),
  };
}

function mapStatusToWorkflowStage(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'published') return 'PUBLISHED';
  if (normalized === 'scheduled') return 'SCHEDULED';
  if (normalized === 'archived') return 'ARCHIVED';
  if (normalized === 'deleted') return 'REJECTED';
  return 'DRAFT';
}

function buildLocalizedBucketFromMaster(masterDoc, lang) {
  const baseLang = getBaseLanguage(masterDoc);
  if (lang === baseLang) {
    return {
      title: safeText(masterDoc.title).trim(),
      summary: safeText(masterDoc.description || masterDoc.summary).trim(),
      content: safeText(masterDoc.content).trim(),
      provider: 'manual',
      generatedAt: masterDoc.updatedAt || masterDoc.lastSyncedAt || new Date(),
    };
  }

  const bucket = isPlainObject(masterDoc?.translations?.[lang]) ? masterDoc.translations[lang] : null;
  if (!hasFullBucket(bucket)) {
    return {
      title: '',
      summary: '',
      content: '',
      provider: normalizeNullableString(bucket?.provider) || 'google',
      generatedAt: null,
    };
  }

  return {
    title: safeText(bucket.title).trim(),
    summary: safeText(bucket.summary).trim(),
    content: safeText(bucket.content).trim(),
    provider: normalizeNullableString(bucket.provider) || 'google',
    generatedAt: bucket.generatedAt || masterDoc.updatedAt || masterDoc.lastSyncedAt || new Date(),
  };
}

function getLocalizedTopLevelContent(masterDoc, childLang) {
  const baseLang = getBaseLanguage(masterDoc);
  if (!childLang || childLang === baseLang) {
    return {
      title: safeText(masterDoc.title).trim(),
      description: safeText(masterDoc.description || masterDoc.summary).trim(),
      content: safeText(masterDoc.content).trim(),
      localizedReady: true,
    };
  }

  const bucket = buildLocalizedBucketFromMaster(masterDoc, childLang);
  const ready = hasFullBucket(bucket)
    && String(masterDoc?.translationStatus?.[childLang] || '').trim().toLowerCase() === 'ready';

  if (!ready) {
    return {
      title: '',
      description: '',
      content: '',
      localizedReady: false,
    };
  }

  return {
    title: bucket.title,
    description: bucket.summary,
    content: bucket.content,
    localizedReady: true,
  };
}

function buildChildNewsSyncPatch(masterDoc, childDoc, options = {}) {
  const master = isPlainObject(masterDoc) ? masterDoc : {};
  const child = isPlainObject(childDoc) ? childDoc : {};
  const now = options.now instanceof Date ? options.now : new Date();
  const propagateCoverMedia = options.propagateCoverMedia === true;
  const metadata = options.metadata || prepareSourceSyncMetadata(master, { now, bumpVersion: false });
  const baseLang = getBaseLanguage(master);
  const childLang = normalizeLang(child.lang || child.language || child.originalLang) || baseLang;
  const localized = getLocalizedTopLevelContent(master, childLang);
  const sourceStatus = String(master.status || 'draft').trim().toLowerCase() || 'draft';

  let nextStatus = sourceStatus;
  if (sourceStatus === 'published' && childLang !== baseLang && !localized.localizedReady) {
    nextStatus = 'draft';
  }

  const nextPublishedAt = nextStatus === 'published' ? (master.publishedAt || now) : null;
  const nextDeletedAt = sourceStatus === 'deleted' ? (master.deletedAt || now) : null;
  const localizedSlug = normalizeNullableString(master?.slugs?.[childLang])
    || (localized.title ? slugifyUnicode(localized.title) : null)
    || normalizeNullableString(child.slug)
    || normalizeNullableString(master.slug);
  const preferredCoverSource = propagateCoverMedia ? master : child;
  const preferredCoverObject = isPlainObject(preferredCoverSource.coverImage) ? cloneSimple(preferredCoverSource.coverImage) : null;
  const preferredCoverUrl = normalizeNullableString(preferredCoverSource?.coverImage?.url)
    || normalizeNullableString(preferredCoverSource.coverImageUrl)
    || normalizeNullableString(preferredCoverSource.imageURL);
  const nextCoverImage = preferredCoverObject || (preferredCoverUrl
    ? { url: preferredCoverUrl, publicId: null, alt: null }
    : null);

  const translations = cloneSimple(master.translations || {});
  const translationStatus = cloneSimple(master.translationStatus || {});
  const translationError = cloneSimple(master.translationError || {});
  const translationNextRetryAt = cloneSimple(master.translationNextRetryAt || {});
  const translationUpdatedAt = cloneSimple(master.translationUpdatedAt || {});

  return {
    title: localized.title,
    description: localized.description,
    content: localized.content,
    slug: localizedSlug,
    slugs: cloneSimple(master.slugs || {}),
    category: normalizeNullableString(master.category),
    tags: normalizeStringArray(master.tags),
    geo: cloneSimple(master.geo || null),
    location: cloneSimple(master.location || null),
    stateTags: normalizeStringArray(master.stateTags),
    stateNames: normalizeStringArray(master.stateNames),
    imageURL: normalizeNullableString(preferredCoverSource.imageURL) || preferredCoverUrl,
    coverImageUrl: preferredCoverUrl,
    coverImage: nextCoverImage,
    externalUrls: normalizeStringArray(master.externalUrls),
    embeds: normalizeStringArray(master.embeds),
    gallery: normalizeStringArray(master.gallery),
    seo: buildSeoObject(master.seo),
    translationKey: getGroupKey(master),
    translationGroupId: getGroupKey(master),
    syncMode: 'auto',
    sourceArticleId: master._id || metadata.sourceArticleId || null,
    sourceLanguage: baseLang,
    lang: childLang,
    language: childLang,
    originalLang: childLang,
    status: nextStatus,
    publishedAt: nextPublishedAt,
    publishAt: nextStatus === 'scheduled' ? (master.publishAt || master.scheduledAt || null) : null,
    scheduledAt: nextStatus === 'scheduled' ? (master.scheduledAt || master.publishAt || null) : null,
    deletedAt: nextDeletedAt,
    workflowStage: mapStatusToWorkflowStage(nextStatus),
    workflowUpdatedAt: now,
    translations,
    translationStatus,
    translationError,
    translationNextRetryAt,
    translationUpdatedAt,
    lastSyncedAt: metadata.lastSyncedAt || now,
    syncVersion: metadata.syncVersion,
    contentFingerprint: metadata.contentFingerprint,
  };
}

function collectTranslationGroupInvalidationTargets(masterDoc, childDocs = []) {
  const docs = [masterDoc, ...(Array.isArray(childDocs) ? childDocs : [])].filter(Boolean);
  const paths = [];
  const tags = [];

  for (const doc of docs) {
    const targets = buildArticleRevalidationTargets(doc);
    paths.push(...targets.paths);
    tags.push(...targets.tags);
  }

  return {
    paths: Array.from(new Set(paths.filter(Boolean))),
    tags: Array.from(new Set(tags.filter(Boolean))),
  };
}

async function syncTranslationGroupFromMaster(masterDoc, options = {}) {
  const logger = options.logger || console;
  const master = isPlainObject(masterDoc) ? masterDoc : null;
  if (!master || !master._id) {
    return { ok: false, childrenUpdated: 0, childIds: [] };
  }

  const groupKey = getGroupKey(master);
  if (!groupKey) {
    return { ok: true, childrenUpdated: 0, childIds: [] };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const metadata = options.metadata || prepareSourceSyncMetadata(master, { now, bumpVersion: false });

  const childDocs = await News.find({
    _id: { $ne: master._id },
    $or: [{ translationKey: groupKey }, { translationGroupId: groupKey }],
  });

  const updatedChildren = [];
  for (const child of childDocs) {
    if (!isChildLinkedToMaster(master, child)) {
      try {
        logger.warn?.('[translationGroupSync] skipped unrelated child in translation group', {
          masterId: String(master._id || ''),
          childId: String(child._id || ''),
          translationGroupId: groupKey,
          childSourceArticleId: normalizeObjectIdString(child.sourceArticleId),
        });
      } catch (_) {}
      continue;
    }

    const patch = buildChildNewsSyncPatch(master, child.toObject ? child.toObject({ virtuals: true }) : child, {
      now,
      metadata,
      propagateCoverMedia: options.propagateCoverMedia === true,
    });

    Object.assign(child, patch);
    await child.save({ validateModifiedOnly: true });
    updatedChildren.push(child);

    try {
      await syncPublicArticleFromNews(child, { logger });
    } catch (error) {
      try {
        logger.warn?.('[translationGroupSync] child public sync failed', {
          childId: String(child._id || ''),
          message: error?.message || String(error),
        });
      } catch (_) {}
    }
  }

  if (options.invalidate !== false) {
    const targets = collectTranslationGroupInvalidationTargets(master, updatedChildren.map((doc) => (doc.toObject ? doc.toObject({ virtuals: true }) : doc)));
    await notifyPublicContentInvalidation({
      reason: String(options.reason || 'translation_group_sync'),
      articleId: String(master._id),
      translationGroupId: groupKey,
      paths: targets.paths,
      tags: targets.tags,
    }, { logger });
  }

  return {
    ok: true,
    childrenUpdated: updatedChildren.length,
    childIds: updatedChildren.map((doc) => String(doc._id)),
  };
}

module.exports = {
  computeContentFingerprint,
  normalizeTranslationGroupKey,
  isChildLinkedToMaster,
  prepareSourceSyncMetadata,
  buildChildNewsSyncPatch,
  collectTranslationGroupInvalidationTargets,
  syncTranslationGroupFromMaster,
};