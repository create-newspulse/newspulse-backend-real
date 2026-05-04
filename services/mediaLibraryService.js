const Media = require('../models/Media');
const cloudinaryUploads = require('../lib/cloudinary');
const {
  buildPublicUrl,
  deriveVideoPosterUrl,
  getMediaLibraryCloudinaryFolder,
} = require('../lib/mediaLibraryStorage');

const MIN_IMAGE_PREVIEW_BYTES = 128;
const MIN_VIDEO_PREVIEW_BYTES = 1024;

function deriveMediaType(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function normalizeCloudinaryPrefix(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '');
}

function getCloudinarySyncPrefixes() {
  return Array.from(new Set([
    'newspulse/media-library',
    'newspulse/articles',
    'newspulse/viral-videos',
    getMediaLibraryCloudinaryFolder(),
    process.env.CLOUDINARY_FOLDER,
    process.env.CLOUDINARY_MEDIA_FOLDER,
  ].map(normalizeCloudinaryPrefix).filter(Boolean)));
}

function formatToMimeType(resourceType, format) {
  const type = String(resourceType || '').trim().toLowerCase();
  const fmt = String(format || '').trim().toLowerCase();
  if (type === 'image') {
    if (fmt === 'jpg' || fmt === 'jpeg') return 'image/jpeg';
    if (fmt) return `image/${fmt}`;
    return 'image/*';
  }
  if (type === 'video') {
    if (fmt) return `video/${fmt}`;
    return 'video/*';
  }
  return fmt ? `${type || 'application'}/${fmt}` : null;
}

function getCloudinaryFileName(asset) {
  const publicId = String(asset?.public_id || '').trim();
  const base = publicId.split('/').filter(Boolean).pop() || 'cloudinary-asset';
  const format = String(asset?.format || '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!format || new RegExp(`\\.${format}$`, 'i').test(base)) return base;
  return `${base}.${format}`;
}

function mapCloudinaryAssetToMediaPayload(asset) {
  const publicId = String(asset?.public_id || '').trim();
  const resourceType = String(asset?.resource_type || '').trim().toLowerCase();
  const url = asset?.secure_url || asset?.url ? String(asset.secure_url || asset.url) : null;
  const mediaType = resourceType === 'video' ? 'video' : resourceType === 'image' ? 'image' : deriveMediaType(formatToMimeType(resourceType, asset?.format));
  const thumbnailUrl = mediaType === 'video' ? deriveVideoPosterUrl(asset) : url;
  const uploadedAt = asset?.created_at ? new Date(asset.created_at) : new Date();

  return {
    storageId: publicId || null,
    cloudinaryPublicId: publicId || null,
    provider: 'cloudinary',
    storageProvider: 'CLOUDINARY',
    resourceType: resourceType || null,
    source: 'admin-media-library',
    status: 'active',
    isDeleted: false,
    type: mediaType,
    mediaType,
    mimeType: formatToMimeType(resourceType, asset?.format),
    fileName: getCloudinaryFileName(asset),
    originalName: getCloudinaryFileName(asset),
    size: typeof asset?.bytes === 'number' ? asset.bytes : 0,
    url,
    assetUrl: url,
    videoUrl: mediaType === 'video' ? url : null,
    posterUrl: mediaType === 'video' ? thumbnailUrl : null,
    thumbnailUrl,
    relativeUrl: null,
    secureUrl: url,
    title: getCloudinaryFileName(asset),
    uploadedAt,
    deletedAt: null,
    restoredAt: null,
  };
}

function isEmptyMediaValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return value <= 0;
  return false;
}

function buildCloudinaryRecordLookup(payload) {
  const clauses = [];
  for (const [field, value] of [
    ['cloudinaryPublicId', payload.cloudinaryPublicId],
    ['storageId', payload.storageId],
    ['assetUrl', payload.assetUrl],
    ['url', payload.url],
    ['secureUrl', payload.secureUrl],
    ['videoUrl', payload.videoUrl],
  ]) {
    if (value) clauses.push({ [field]: value });
  }
  return clauses.length ? { $or: clauses } : null;
}

function applyMissingCloudinaryFields(doc, payload) {
  const fields = [
    'cloudinaryPublicId',
    'storageId',
    'provider',
    'storageProvider',
    'resourceType',
    'source',
    'status',
    'type',
    'mediaType',
    'mimeType',
    'fileName',
    'originalName',
    'size',
    'url',
    'assetUrl',
    'videoUrl',
    'posterUrl',
    'thumbnailUrl',
    'secureUrl',
    'title',
    'uploadedAt',
  ];
  let changed = false;

  for (const field of fields) {
    if (!isEmptyMediaValue(payload[field]) && isEmptyMediaValue(doc[field])) {
      doc[field] = payload[field];
      changed = true;
    }
  }

  return changed;
}

async function scanCloudinaryMediaLibraryAssets(options = {}) {
  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length
    ? Array.from(new Set(options.prefixes.map(normalizeCloudinaryPrefix).filter(Boolean)))
    : getCloudinarySyncPrefixes();
  const resourceTypes = ['image', 'video'];
  const assetsByKey = new Map();
  const scanResults = [];

  for (const prefix of prefixes) {
    for (const resourceType of resourceTypes) {
      const result = await cloudinaryUploads.listResourcesByPrefix({
        prefix,
        resourceType,
        maxResults: options.maxResults || 500,
        maxPages: options.maxPages || 50,
      });
      const resources = Array.isArray(result?.resources) ? result.resources : [];
      scanResults.push({
        prefix,
        resourceType,
        count: resources.length,
        truncated: result?.truncated === true,
      });
      for (const resource of resources) {
        const publicId = String(resource?.public_id || '').trim();
        if (!publicId) continue;
        assetsByKey.set(`${resourceType}:${publicId}`, { ...resource, resource_type: resource.resource_type || resourceType });
      }
    }
  }

  return {
    prefixes,
    scanResults,
    assets: Array.from(assetsByKey.values()),
  };
}

async function importCloudinaryAssetToMediaLibrary(asset) {
  const payload = mapCloudinaryAssetToMediaPayload(asset);
  if (!payload.cloudinaryPublicId || !payload.assetUrl || !['image', 'video'].includes(payload.mediaType)) {
    const err = new Error('Cloudinary asset is missing required media fields');
    err.status = 422;
    err.code = 'CLOUDINARY_ASSET_INVALID';
    throw err;
  }

  const lookup = buildCloudinaryRecordLookup(payload);
  const existing = lookup ? await Media.findOne(lookup) : null;
  if (existing) {
    const changed = applyMissingCloudinaryFields(existing, payload);
    if (changed && typeof existing.save === 'function') await existing.save();
    return { action: changed ? 'updated-existing' : 'skipped-existing', mediaType: payload.mediaType, id: String(existing._id || existing.id || '') };
  }

  const created = await Media.create(payload);
  return { action: 'imported', mediaType: payload.mediaType, id: String(created?._id || created?.id || '') };
}

function logCloudinarySync(event, details = {}, level = 'log') {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  logger(`[media-library.sync-cloudinary][${event}]`, details);
}

async function syncCloudinaryMediaLibrary(options = {}) {
  const config = cloudinaryUploads.getCloudinaryConfigStatus();
  if (!config.configured) {
    const err = new Error('Cloudinary is not configured for Media Library sync');
    err.status = 503;
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }

  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length
    ? Array.from(new Set(options.prefixes.map(normalizeCloudinaryPrefix).filter(Boolean)))
    : getCloudinarySyncPrefixes();

  logCloudinarySync('started', { foldersScanned: prefixes });
  const scanned = await scanCloudinaryMediaLibraryAssets({ ...options, prefixes });
  logCloudinarySync('assets-found', {
    foldersScanned: scanned.prefixes,
    scanResults: scanned.scanResults,
    totalScanned: scanned.assets.length,
  });

  const summary = {
    ok: true,
    importedImages: 0,
    importedVideos: 0,
    skippedExisting: 0,
    failed: 0,
    totalScanned: scanned.assets.length,
  };

  for (const asset of scanned.assets) {
    try {
      const result = await importCloudinaryAssetToMediaLibrary(asset);
      if (result.action === 'imported' && result.mediaType === 'image') summary.importedImages += 1;
      else if (result.action === 'imported' && result.mediaType === 'video') summary.importedVideos += 1;
      else summary.skippedExisting += 1;
    } catch (e) {
      summary.failed += 1;
      logCloudinarySync('asset-failed', {
        publicId: asset?.public_id || null,
        resourceType: asset?.resource_type || null,
        message: e?.message || String(e),
      }, 'warn');
    }
  }

  logCloudinarySync('completed', {
    foldersScanned: scanned.prefixes,
    importedImages: summary.importedImages,
    importedVideos: summary.importedVideos,
    skippedExisting: summary.skippedExisting,
    failed: summary.failed,
    totalScanned: summary.totalScanned,
  });

  return summary;
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
    fileName: doc.fileName || null,
    originalName: doc.originalName || doc.fileName || null,
    title: doc.title || doc.originalName || doc.fileName || null,
    size,
    fileSize: size,
    mimeType: doc.mimeType || null,
    type: doc.type || mediaType,
    mediaType,
    provider: doc.provider || 'unknown',
    storageProvider: normalizeStorageProvider(doc),
    resourceType: doc.resourceType || null,
    cloudinaryPublicId: doc.cloudinaryPublicId || null,
    source: doc.source || null,
    status: doc.status || 'active',
    isDeleted: doc.isDeleted === true,
    deleted: doc.isDeleted === true,
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
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    uploadedBy: doc.uploadedBy || null,
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
    cloudinaryPublicId: uploaded && uploaded.provider === 'cloudinary' && uploaded.id ? String(uploaded.id) : null,
    provider: uploaded && uploaded.provider ? String(uploaded.provider) : 'unknown',
    storageProvider: normalizeStorageProvider(uploaded),
    resourceType: mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : null,
    source: options.source || 'admin-media-library',
    status: 'active',
    isDeleted: false,
    type: mediaType,
    mediaType,
    mimeType: uploaded && uploaded.mimeType ? String(uploaded.mimeType) : null,
    fileName: uploaded && uploaded.fileName ? String(uploaded.fileName) : null,
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
  if (!options.includeDeleted) filter.isDeleted = false;
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
  const [all, active, photos, videos, trash] = await Promise.all([
    Media.countDocuments({}),
    Media.countDocuments({ isDeleted: false }),
    Media.countDocuments({ isDeleted: false, mediaType: { $in: ['image', 'photo'] } }),
    Media.countDocuments({ isDeleted: false, mediaType: 'video' }),
    Media.countDocuments({ isDeleted: true }),
  ]);

  return { all, active, photos, videos, trash };
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
  doc.status = 'trash';
  doc.deletedAt = new Date();
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
  doc.restoredAt = new Date();
  await doc.save();
  return mapMediaRecord(doc.toObject());
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
  getCloudinarySyncPrefixes,
  importCloudinaryAssetToMediaLibrary,
  listIndexedMediaRecords,
  mapMediaRecord,
  markMediaDeleted,
  removeMediaRecord,
  restoreMediaRecord,
  scanCloudinaryMediaLibraryAssets,
  syncCloudinaryMediaLibrary,
  verifyIndexedMediaRecordReadable,
  verifyIndexedMediaRecordVisible,
};