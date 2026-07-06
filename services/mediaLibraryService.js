const Media = require('../models/Media');
const { buildPublicUrl, deleteMediaLibraryItem } = require('../lib/mediaLibraryStorage');
const cloudinaryUploads = require('../lib/cloudinary');

const Article = require('../models/Article');
const News = require('../models/News');
const ViralVideo = require('../models/ViralVideo');
const Ad = require('../models/Ad');
const SponsoredFeature = require('../models/SponsoredFeature');
const PublicSiteSettings = require('../models/PublicSiteSettings');

const MIN_IMAGE_PREVIEW_BYTES = 128;
const MIN_VIDEO_PREVIEW_BYTES = 1024;

function deriveMediaType(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function buildMediaTypeFilter(mediaType) {
  const normalized = String(mediaType || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'photo' || normalized === 'image') {
    return { $in: ['image', 'photo'] };
  }
  return normalized;
}

function resolveMediaAssetUrl(doc, options = {}) {
  const relativeUrl = doc && doc.relativeUrl ? String(doc.relativeUrl) : null;
  const provider = String(doc?.provider || '').toLowerCase();
  if (relativeUrl && provider === 'local-disk' && options.req) {
    return buildPublicUrl(options.req, relativeUrl);
  }
  return doc?.assetUrl || doc?.url || doc?.secureUrl || relativeUrl || null;
}

function normalizeStorageProvider(uploadedOrDoc) {
  const explicit = String(uploadedOrDoc?.storageProvider || '').trim();
  if (explicit) return explicit;
  const provider = String(uploadedOrDoc?.provider || '').trim().toLowerCase();
  if (provider === 'cloudinary') return 'CLOUDINARY';
  if (provider === 'local-disk') return 'LOCAL_DISK';
  return provider ? provider.toUpperCase() : null;
}

function mapMediaRecord(doc, options = {}) {
  if (!doc) return null;
  const size = typeof doc.size === 'number' ? doc.size : 0;
  const assetUrl = resolveMediaAssetUrl(doc, options);
  const secureUrl = assetUrl || doc.secureUrl || doc.url || null;
  const mediaType = doc.mediaType || 'file';
  const isImage = mediaType === 'image' || mediaType === 'photo';
  const isVideo = mediaType === 'video';
  const minPreviewBytes = isVideo ? MIN_VIDEO_PREVIEW_BYTES : isImage ? MIN_IMAGE_PREVIEW_BYTES : 0;
  const previewAvailable = !!assetUrl && (!minPreviewBytes || size >= minPreviewBytes);
  const previewReason = previewAvailable
    ? null
    : !assetUrl
      ? 'ASSET_URL_MISSING'
      : size < minPreviewBytes
        ? 'FILE_TOO_SMALL_FOR_PREVIEW'
        : 'PREVIEW_UNAVAILABLE';
  const previewUrl = previewAvailable && isImage ? assetUrl : null;
  const videoUrl = isVideo ? (doc.videoUrl || assetUrl) : null;
  const thumbnailUrl = doc.thumbnailUrl || (previewAvailable && isImage ? assetUrl : null);
  const playbackUrl = previewAvailable && isVideo ? videoUrl : null;
  const posterUrl = isVideo ? (doc.posterUrl || thumbnailUrl || null) : thumbnailUrl;
  const uploadedAt = doc.uploadedAt || doc.createdAt || null;

  return {
    id: String(doc._id),
    storageId: doc.storageId || null,
    publicId: doc.publicId || doc.storageId || null,
    fileName: doc.fileName || null,
    filename: doc.filename || doc.fileName || null,
    originalName: doc.originalName || doc.fileName || null,
    title: doc.title || doc.originalName || doc.fileName || null,
    size,
    fileSize: size,
    mimeType: doc.mimeType || null,
    mediaType,
    provider: doc.provider || 'unknown',
    storageProvider: normalizeStorageProvider(doc),
    source: doc.source || null,
    status: normalizeMediaStatus(doc.status, doc.isDeleted),
    isDeleted: doc.isDeleted === true,
    deleted: doc.isDeleted === true,
    isUsed: doc.isUsed === true,
    usageCount: typeof doc.usageCount === 'number' ? doc.usageCount : 0,
    url: assetUrl,
    assetUrl,
    videoUrl,
    originalUrl: assetUrl,
    previewUrl,
    thumbnailUrl,
    playbackUrl,
    posterUrl,
    secureUrl,
    previewAvailable,
    previewReason,
    relativeUrl: doc.relativeUrl || null,
    uploadedAt: uploadedAt ? new Date(uploadedAt).toISOString() : null,
    trashedAt: doc.trashedAt ? new Date(doc.trashedAt).toISOString() : null,
    deletedAt: doc.deletedAt ? new Date(doc.deletedAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    uploadedBy: doc.uploadedBy || null,
  };
}

function normalizeMediaStatus(status, isDeleted = false) {
  const raw = String(status || '').trim().toLowerCase();
  if (raw === 'deleted') return 'deleted';
  if (raw === 'trashed' || raw === 'trash') return 'trashed';
  if (isDeleted === true) return 'trashed';
  return 'active';
}

function buildActiveMediaFilter() {
  return {
    isDeleted: { $ne: true },
    status: { $nin: ['trash', 'trashed', 'deleted'] },
  };
}

function buildTrashedMediaFilter() {
  return {
    $or: [
      { status: 'trashed' },
      { status: 'trash' },
      { isDeleted: true, status: { $ne: 'deleted' } },
    ],
  };
}

async function createIndexedMediaRecord(req, uploaded, options = {}) {
  const mediaType = options.mediaType || deriveMediaType(uploaded && uploaded.mimeType);
  const assetUrl = uploaded && (uploaded.assetUrl || uploaded.url || uploaded.secureUrl) ? String(uploaded.assetUrl || uploaded.url || uploaded.secureUrl) : null;
  const thumbnailUrl = uploaded && uploaded.thumbnailUrl ? String(uploaded.thumbnailUrl) : (mediaType === 'image' ? assetUrl : null);
  const videoUrl = uploaded && uploaded.videoUrl ? String(uploaded.videoUrl) : (mediaType === 'video' ? assetUrl : null);
  const posterUrl = uploaded && uploaded.posterUrl ? String(uploaded.posterUrl) : (mediaType === 'video' ? thumbnailUrl : null);
  const uploadedBy = req && req.admin ? {
    id: req.admin.id || null,
    email: req.admin.email || null,
    role: req.admin.role || null,
  } : { id: null, email: null, role: null };

  const created = await Media.create({
    storageId: uploaded && uploaded.id ? String(uploaded.id) : null,
    provider: uploaded && uploaded.provider ? String(uploaded.provider) : 'unknown',
    storageProvider: normalizeStorageProvider(uploaded),
    source: options.source || 'admin-media-library',
    status: 'active',
    isDeleted: false,
    publicId: uploaded && uploaded.id ? String(uploaded.id) : null,
    mediaType,
    mimeType: uploaded && uploaded.mimeType ? String(uploaded.mimeType) : null,
    fileName: uploaded && uploaded.fileName ? String(uploaded.fileName) : null,
    filename: uploaded && uploaded.fileName ? String(uploaded.fileName) : null,
    originalName: uploaded && uploaded.name ? String(uploaded.name) : (uploaded && uploaded.fileName ? String(uploaded.fileName) : null),
    size: typeof uploaded?.size === 'number' ? uploaded.size : 0,
    url: assetUrl,
    assetUrl,
    videoUrl,
    posterUrl,
    thumbnailUrl,
    relativeUrl: uploaded && uploaded.relativeUrl ? String(uploaded.relativeUrl) : null,
    secureUrl: assetUrl,
    title: uploaded && uploaded.name ? String(uploaded.name) : null,
    uploadedAt: uploaded && uploaded.uploadedAt ? new Date(uploaded.uploadedAt) : new Date(),
    uploadedBy,
    isUsed: false,
    usageCount: 0,
    trashedAt: null,
    deletedAt: null,
    restoredAt: null,
  });

  const verified = await Media.findById(created._id).lean();
  if (!verified) {
    const err = new Error('Media record was not queryable after create');
    err.status = 500;
    err.code = 'MEDIA_INDEX_VERIFY_FAILED';
    throw err;
  }

  return mapMediaRecord(verified, { req });
}

function buildListFilter(options = {}) {
  const filter = {};
  const status = normalizeMediaStatus(options.status, false);
  if (status === 'trashed') {
    Object.assign(filter, buildTrashedMediaFilter());
  } else if (status === 'deleted') {
    filter.status = 'deleted';
  } else if (!options.includeDeleted) {
    Object.assign(filter, buildActiveMediaFilter());
  }
  const mediaTypeFilter = buildMediaTypeFilter(options.mediaType);
  if (mediaTypeFilter) filter.mediaType = mediaTypeFilter;
  if (options.source) filter.source = String(options.source);
  return filter;
}

async function listIndexedMediaRecords(options = {}) {
  const docs = await Media.find(buildListFilter(options)).sort({ createdAt: -1 }).lean();
  return docs.map((doc) => mapMediaRecord(doc, { req: options.req || null }));
}

async function getIndexedMediaStats() {
  const [all, activeMedia, images, videos, trash, usedAssets] = await Promise.all([
    Media.countDocuments({}),
    Media.countDocuments(buildActiveMediaFilter()),
    Media.countDocuments({ ...buildActiveMediaFilter(), mediaType: { $in: ['image', 'photo'] } }),
    Media.countDocuments({ ...buildActiveMediaFilter(), mediaType: 'video' }),
    Media.countDocuments(buildTrashedMediaFilter()),
    Media.countDocuments({ ...buildActiveMediaFilter(), usageCount: { $gt: 0 } }),
  ]);

  return { all, active: activeMedia, activeMedia, photos: images, images, videos, usedAssets, trash };
}

async function verifyIndexedMediaRecordVisible(identifier, options = {}) {
  const doc = await findMediaRecordByIdOrStorageId(identifier);
  if (!doc) {
    const err = new Error('Media record was not queryable after create');
    err.status = 500;
    err.code = 'MEDIA_INDEX_VERIFY_FAILED';
    throw err;
  }

  const filter = buildListFilter({
    includeDeleted: false,
    mediaType: options.mediaType || null,
    source: options.source || null,
  });
  filter._id = doc._id;

  const visible = await Media.exists(filter);
  if (!visible) {
    const err = new Error('Media record was not visible to the library list after create');
    err.status = 500;
    err.code = 'MEDIA_LIST_VERIFY_FAILED';
    throw err;
  }

  return mapMediaRecord(doc.toObject ? doc.toObject() : doc);
}

async function verifyIndexedMediaRecordReadable(identifier, options = {}) {
  const doc = await findMediaRecordByIdOrStorageId(identifier);
  if (!doc) {
    const err = new Error('Media record was not queryable after create');
    err.status = 500;
    err.code = 'MEDIA_INDEX_VERIFY_FAILED';
    throw err;
  }

  const source = options.source ? String(options.source) : null;
  const listFilter = buildListFilter({
    includeDeleted: false,
    mediaType: options.mediaType || doc.mediaType || null,
    source,
  });
  listFilter._id = doc._id;

  const activeStatsFilter = {
    _id: doc._id,
    isDeleted: false,
    ...(source ? { source } : {}),
  };

  const mediaType = String(doc.mediaType || '').toLowerCase();
  let typedStatsFilter = null;
  if (mediaType === 'video') {
    typedStatsFilter = { ...activeStatsFilter, mediaType: 'video' };
  } else if (mediaType === 'image' || mediaType === 'photo') {
    typedStatsFilter = { ...activeStatsFilter, mediaType: { $in: ['image', 'photo'] } };
  }

  const [listVisible, activeStatsVisible, typedStatsVisible] = await Promise.all([
    Media.exists(listFilter),
    Media.exists(activeStatsFilter),
    typedStatsFilter ? Media.exists(typedStatsFilter) : true,
  ]);

  if (!listVisible) {
    const err = new Error('Media record was not visible to the library list after create');
    err.status = 500;
    err.code = 'MEDIA_LIST_VERIFY_FAILED';
    throw err;
  }

  if (!activeStatsVisible || !typedStatsVisible) {
    const err = new Error('Media record was not visible to the library stats after create');
    err.status = 500;
    err.code = 'MEDIA_STATS_VERIFY_FAILED';
    throw err;
  }

  return {
    record: mapMediaRecord(doc.toObject ? doc.toObject() : doc, { req: options.req || null }),
    debug: {
      listVisible: !!listVisible,
      activeStatsVisible: !!activeStatsVisible,
      typedStatsVisible: !!typedStatsVisible,
    },
  };
}

async function findMediaRecordByIdOrStorageId(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;

  let doc = null;
  try {
    doc = await Media.findById(id);
  } catch (_) {
    doc = null;
  }
  if (doc) return doc;
  return Media.findOne({ storageId: id });
}

async function markMediaDeleted(identifier, actor) {
  const doc = await findMediaRecordByIdOrStorageId(identifier);
  if (!doc) {
    const err = new Error('Media record not found');
    err.status = 404;
    throw err;
  }
  doc.isDeleted = true;
  doc.status = 'trashed';
  doc.trashedAt = new Date();
  doc.deletedAt = null;
  doc.restoredAt = null;
  if (actor && actor.email && !doc.uploadedBy?.email) {
    doc.uploadedBy = { id: actor.id || null, email: actor.email, role: actor.role || null };
  }
  await doc.save();
  return mapMediaRecord(doc.toObject(), { req: actor?.req || null });
}

async function restoreMediaRecord(identifier) {
  const doc = await findMediaRecordByIdOrStorageId(identifier);
  if (!doc) {
    const err = new Error('Media record not found');
    err.status = 404;
    throw err;
  }
  doc.isDeleted = false;
  doc.status = 'active';
  doc.deletedAt = null;
  doc.trashedAt = null;
  doc.restoredAt = new Date();
  await doc.save();
  return mapMediaRecord(doc.toObject());
}

function normalizeBulkMediaIds(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((value) => String(value || '').trim()).filter(Boolean)));
}

function buildMediaLookupValues(media) {
  const mapped = media && media.toObject ? media.toObject() : media;
  return Array.from(new Set([
    mapped?._id ? String(mapped._id) : null,
    mapped?.storageId,
    mapped?.publicId,
    mapped?.url,
    mapped?.assetUrl,
    mapped?.secureUrl,
    mapped?.relativeUrl,
    mapped?.videoUrl,
    mapped?.thumbnailUrl,
    mapped?.posterUrl,
    mapped?.fileName,
    mapped?.filename,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function valueContainsMediaNeedle(value, needles) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const raw = String(value);
    const match = needles.find((needle) => needle && raw.includes(needle));
    return match || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = valueContainsMediaNeedle(item, needles);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = valueContainsMediaNeedle(item, needles);
      if (found) return found;
    }
  }
  return null;
}

function compactUsage(usage) {
  return {
    type: usage.type,
    title: usage.title || null,
    section: usage.section || null,
    id: usage.id ? String(usage.id) : null,
    url: usage.url || null,
  };
}

function collectDocUsage(doc, { type, section, titleFields = ['title', 'headline', 'internalTitle'], needles }) {
  if (!doc) return null;
  const raw = doc.toObject ? doc.toObject() : doc;
  const matched = valueContainsMediaNeedle(raw, needles);
  if (!matched) return null;
  const title = titleFields.map((field) => raw[field]).find((value) => String(value || '').trim()) || null;
  return compactUsage({ type, section, title: title ? String(title) : null, id: raw._id || raw.id, url: matched });
}

async function findMediaUsageForRecord(media) {
  const needles = buildMediaLookupValues(media);
  if (!needles.length) return [];

  const usageGroups = await Promise.all([
    News.find({}).limit(1000).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'news', section: 'News Article', needles })).filter(Boolean)).catch(() => []),
    Article.find({}).limit(1000).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'article', section: 'Public Article', needles })).filter(Boolean)).catch(() => []),
    ViralVideo.find({}).limit(1000).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'viral-video', section: 'Viral Videos', needles })).filter(Boolean)).catch(() => []),
    Ad.find({}).limit(1000).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'ad', section: doc.slot || 'Ads/Sponsored Blocks', needles })).filter(Boolean)).catch(() => []),
    SponsoredFeature.find({}).limit(1000).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'sponsored-feature', section: doc.placementKey || doc.placement || 'Homepage Featured Sections', titleFields: ['headline', 'internalTitle', 'sponsorName'], needles })).filter(Boolean)).catch(() => []),
    PublicSiteSettings.find({}).limit(50).lean().then((docs) => docs.map((doc) => collectDocUsage(doc, { type: 'site-settings', section: 'Homepage Featured Sections', titleFields: ['scope'], needles })).filter(Boolean)).catch(() => []),
  ]);

  return usageGroups.flat();
}

async function bulkUsageCheck(ids) {
  const normalizedIds = normalizeBulkMediaIds(ids);
  const results = [];
  for (const id of normalizedIds) {
    const media = await findMediaRecordByIdOrStorageId(id);
    if (!media) {
      results.push({ mediaId: id, isUsed: false, usageCount: 0, usages: [], missing: true });
      continue;
    }
    const usages = await findMediaUsageForRecord(media);
    media.isUsed = usages.length > 0;
    media.usageCount = usages.length;
    await media.save();
    results.push({ mediaId: String(media._id), storageId: media.storageId || null, isUsed: usages.length > 0, usageCount: usages.length, usages });
  }
  return results;
}

async function bulkTrashMedia(ids, options = {}) {
  const usageResults = await bulkUsageCheck(ids);
  const used = usageResults.filter((item) => item.isUsed);
  if (used.length && options.forceFounderConfirm !== true) {
    const err = new Error('Some selected media is currently used. Confirm as Founder/Admin before moving to Trash.');
    err.status = 409;
    err.code = 'MEDIA_IN_USE_CONFIRM_REQUIRED';
    err.results = usageResults;
    throw err;
  }

  const trashedIds = [];
  const skippedIds = [];
  for (const id of normalizeBulkMediaIds(ids)) {
    try {
      const trashed = await markMediaDeleted(id, options.actor || null);
      trashedIds.push(trashed.id || id);
    } catch (_) {
      skippedIds.push(id);
    }
  }
  return { usageResults, trashedIds, skippedIds };
}

async function bulkRestoreMedia(ids) {
  const restoredIds = [];
  const skippedIds = [];
  for (const id of normalizeBulkMediaIds(ids)) {
    try {
      const restored = await restoreMediaRecord(id);
      restoredIds.push(restored.id || id);
    } catch (_) {
      skippedIds.push(id);
    }
  }
  return { restoredIds, skippedIds };
}

function isTrashedMediaRecord(doc) {
  return normalizeMediaStatus(doc?.status, doc?.isDeleted) === 'trashed';
}

async function tryDeleteCloudinaryAsset(media) {
  const provider = String(media.provider || media.storageProvider || '').toLowerCase();
  if (provider.includes('local')) {
    const localId = String(media.storageId || media.publicId || '').trim();
    if (!localId) return { attempted: false, reason: 'storageId missing' };
    const result = await deleteMediaLibraryItem(localId);
    return { attempted: true, result };
  }

  if (!cloudinaryUploads.isCloudinaryConfigured()) return { attempted: false, reason: 'Cloudinary not configured' };
  const publicId = String(media.publicId || media.storageId || '').trim();
  if (!publicId) return { attempted: false, reason: 'publicId missing' };
  const result = await cloudinaryUploads.deleteAssetByPublicId(publicId, { resourceType: media.mediaType === 'video' ? 'video' : 'image' });
  return { attempted: true, result };
}

async function bulkPermanentDeleteMedia(ids, options = {}) {
  if (options.confirm !== 'PERMANENT DELETE') {
    const err = new Error('Permanent delete requires confirm: "PERMANENT DELETE".');
    err.status = 400;
    err.code = 'PERMANENT_DELETE_CONFIRM_REQUIRED';
    throw err;
  }

  const usageResults = await bulkUsageCheck(ids);
  const used = usageResults.filter((item) => item.isUsed);
  if (used.length) {
    const err = new Error('Permanent delete blocked because one or more media items are still used.');
    err.status = 409;
    err.code = 'MEDIA_IN_USE_PERMANENT_DELETE_BLOCKED';
    err.results = usageResults;
    throw err;
  }

  const permanentlyDeletedIds = [];
  const skippedIds = [];
  const deleteResults = [];
  for (const id of normalizeBulkMediaIds(ids)) {
    const media = await findMediaRecordByIdOrStorageId(id);
    if (!media || !isTrashedMediaRecord(media)) {
      skippedIds.push(id);
      continue;
    }

    let providerDelete = null;
    try {
      providerDelete = await tryDeleteCloudinaryAsset(media);
    } catch (error) {
      providerDelete = { attempted: true, error: error?.message || String(error) };
    }

    media.status = 'deleted';
    media.isDeleted = true;
    media.deletedAt = new Date();
    await media.save();
    permanentlyDeletedIds.push(String(media._id));
    deleteResults.push({ mediaId: String(media._id), storageId: media.storageId || null, providerDelete });
  }

  return { usageResults, permanentlyDeletedIds, skippedIds, deleteResults };
}

async function removeMediaRecord(identifier) {
  const doc = await findMediaRecordByIdOrStorageId(identifier);
  if (!doc) return null;
  const mapped = mapMediaRecord(doc.toObject());
  await Media.deleteOne({ _id: doc._id });
  return mapped;
}

module.exports = {
  createIndexedMediaRecord,
  deriveMediaType,
  findMediaRecordByIdOrStorageId,
  getIndexedMediaStats,
  bulkPermanentDeleteMedia,
  bulkRestoreMedia,
  bulkTrashMedia,
  bulkUsageCheck,
  buildActiveMediaFilter,
  listIndexedMediaRecords,
  mapMediaRecord,
  markMediaDeleted,
  removeMediaRecord,
  restoreMediaRecord,
  verifyIndexedMediaRecordReadable,
  verifyIndexedMediaRecordVisible,
};