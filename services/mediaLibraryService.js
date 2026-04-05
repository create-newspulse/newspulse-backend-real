const Media = require('../models/Media');
const { buildPublicUrl } = require('../lib/mediaLibraryStorage');

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
  return doc?.url || doc?.secureUrl || relativeUrl || null;
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
  const thumbnailUrl = previewAvailable && isImage ? assetUrl : null;
  const playbackUrl = previewAvailable && isVideo ? assetUrl : null;
  const posterUrl = isVideo ? null : thumbnailUrl;

  return {
    id: String(doc._id),
    storageId: doc.storageId || null,
    fileName: doc.fileName || null,
    originalName: doc.originalName || doc.fileName || null,
    title: doc.title || doc.originalName || doc.fileName || null,
    size,
    fileSize: size,
    mimeType: doc.mimeType || null,
    mediaType,
    provider: doc.provider || 'unknown',
    source: doc.source || null,
    status: doc.status || 'active',
    isDeleted: doc.isDeleted === true,
    deleted: doc.isDeleted === true,
    url: assetUrl,
    assetUrl,
    originalUrl: assetUrl,
    previewUrl,
    thumbnailUrl,
    playbackUrl,
    posterUrl,
    secureUrl,
    previewAvailable,
    previewReason,
    relativeUrl: doc.relativeUrl || null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    uploadedBy: doc.uploadedBy || null,
  };
}

async function createIndexedMediaRecord(req, uploaded, options = {}) {
  const mediaType = options.mediaType || deriveMediaType(uploaded && uploaded.mimeType);
  const uploadedBy = req && req.admin ? {
    id: req.admin.id || null,
    email: req.admin.email || null,
    role: req.admin.role || null,
  } : { id: null, email: null, role: null };

  const created = await Media.create({
    storageId: uploaded && uploaded.id ? String(uploaded.id) : null,
    provider: uploaded && uploaded.provider ? String(uploaded.provider) : 'unknown',
    source: options.source || 'admin-media-library',
    status: 'active',
    isDeleted: false,
    mediaType,
    mimeType: uploaded && uploaded.mimeType ? String(uploaded.mimeType) : null,
    fileName: uploaded && uploaded.fileName ? String(uploaded.fileName) : null,
    originalName: uploaded && uploaded.name ? String(uploaded.name) : (uploaded && uploaded.fileName ? String(uploaded.fileName) : null),
    size: typeof uploaded?.size === 'number' ? uploaded.size : 0,
    url: uploaded && uploaded.url ? String(uploaded.url) : null,
    relativeUrl: uploaded && uploaded.relativeUrl ? String(uploaded.relativeUrl) : null,
    secureUrl: uploaded && uploaded.url ? String(uploaded.url) : null,
    title: uploaded && uploaded.name ? String(uploaded.name) : null,
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
  listIndexedMediaRecords,
  mapMediaRecord,
  markMediaDeleted,
  removeMediaRecord,
  restoreMediaRecord,
  verifyIndexedMediaRecordReadable,
  verifyIndexedMediaRecordVisible,
};