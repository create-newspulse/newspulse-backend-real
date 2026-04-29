const multer = require('multer');
const mongoose = require('mongoose');

const mediaLibraryStorage = require('../lib/mediaLibraryStorage');
const mediaLibraryService = require('../services/mediaLibraryService');
const ViralVideo = require('../models/ViralVideo');
const {
  getViralVideosSettings: readViralVideosSettings,
  saveViralVideosSettings,
} = require('../lib/viralVideosSettings');

const viralVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 },
});

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return fallback;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str || null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
  if (typeof value === 'string') return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
  return [];
}

function normalizePosterImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { url: null, publicId: null, alt: null };
  return {
    url: normalizeOptionalString(value.url),
    publicId: normalizeOptionalString(value.publicId),
    alt: normalizeOptionalString(value.alt),
  };
}

function normalizeUploadedVideo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      storageId: null,
      fileName: null,
      originalName: null,
      mimeType: null,
      provider: null,
      relativeUrl: null,
      url: null,
      size: 0,
    };
  }
  return {
    storageId: normalizeOptionalString(value.storageId),
    fileName: normalizeOptionalString(value.fileName),
    originalName: normalizeOptionalString(value.originalName),
    mimeType: normalizeOptionalString(value.mimeType),
    provider: normalizeOptionalString(value.provider),
    relativeUrl: normalizeOptionalString(value.relativeUrl),
    url: normalizeOptionalString(value.url),
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : 0,
  };
}

function toAdminViralVideoDto(doc) {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : doc;
  return {
    id: String(source._id || source.id || ''),
    _id: source._id || source.id || null,
    title: source.title || null,
    slug: source.slug || null,
    summary: source.summary || null,
    shortCaption: source.summary || null,
    thumbnailUrl: source.thumbnailUrl || source.posterImage?.url || null,
    posterImage: normalizePosterImage(source.posterImage),
    thumbnail: normalizePosterImage(source.posterImage),
    uploadedVideo: normalizeUploadedVideo(source.uploadedVideo),
    videoUrl: source.videoUrl || null,
    embedUrl: source.embedUrl || null,
    sourceType: source.sourceType || 'embed',
    language: source.language || 'en',
    category: source.category || null,
    tags: Array.isArray(source.tags) ? source.tags : [],
    isPublished: source.isPublished === true,
    status: source.status || (source.isPublished === true ? 'published' : 'draft'),
    isHomepageVisible: source.isHomepageVisible !== false,
    homepageFeatured: source.homepageFeatured === true || source.isFeatured === true,
    isFeatured: source.isFeatured === true,
    isFeaturedHomepage: source.isFeatured === true,
    publishedAt: source.publishedAt || null,
    sortOrder: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function buildListFilter(query = {}) {
  const filter = {};
  if (query.status === 'published') filter.isPublished = true;
  if (query.status === 'draft') filter.isPublished = false;
  if (query.published === 'true' || query.isPublished === 'true') filter.isPublished = true;
  if (query.published === 'false' || query.isPublished === 'false') filter.isPublished = false;
  if (query.lang || query.language) filter.language = String(query.lang || query.language).trim().toLowerCase();
  if (query.category) filter.category = String(query.category).trim();
  if (query.tag) filter.tags = String(query.tag).trim();
  return filter;
}

function buildListSort(query = {}) {
  if (String(query.publishedAt || '').toLowerCase() === 'asc') return { publishedAt: 1, sortOrder: -1, createdAt: -1 };
  if (String(query.createdAt || '').toLowerCase() === 'asc') return { createdAt: 1 };
  if (String(query.createdAt || '').toLowerCase() === 'desc') return { createdAt: -1 };
  return { publishedAt: -1, sortOrder: -1, createdAt: -1 };
}

function buildViralVideoPayload(body = {}, { partial = false } = {}) {
  const payload = {};
  const assignString = (key, targetKey = key) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) payload[targetKey] = normalizeOptionalString(body[key]);
  };

  assignString('title');
  assignString('slug');
  assignString('summary');
  assignString('shortCaption', 'summary');
  assignString('thumbnailUrl');
  assignString('videoUrl');
  assignString('embedUrl');
  assignString('sourceType');
  assignString('language');
  assignString('category');
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) payload.tags = normalizeStringArray(body.tags);
  if (Object.prototype.hasOwnProperty.call(body, 'posterImage')) payload.posterImage = normalizePosterImage(body.posterImage);
  if (Object.prototype.hasOwnProperty.call(body, 'thumbnail')) payload.posterImage = normalizePosterImage(body.thumbnail);
  if (Object.prototype.hasOwnProperty.call(body, 'thumbnailUrl')) {
    const thumbnailUrl = normalizeOptionalString(body.thumbnailUrl);
    payload.thumbnailUrl = thumbnailUrl;
    if (!payload.posterImage && thumbnailUrl) payload.posterImage = { url: thumbnailUrl, publicId: null, alt: null };
  }
  if (payload.posterImage && payload.posterImage.url && !payload.thumbnailUrl) payload.thumbnailUrl = payload.posterImage.url;
  if (Object.prototype.hasOwnProperty.call(body, 'uploadedVideo')) payload.uploadedVideo = normalizeUploadedVideo(body.uploadedVideo);
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = String(body.status || '').trim().toLowerCase() === 'published' ? 'published' : 'draft';
    payload.status = status;
    payload.isPublished = status === 'published';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isPublished')) payload.isPublished = normalizeBoolean(body.isPublished);
  if (payload.isPublished === true && !payload.status) payload.status = 'published';
  if (payload.isPublished === false && !payload.status) payload.status = 'draft';
  if (Object.prototype.hasOwnProperty.call(body, 'isHomepageVisible')) payload.isHomepageVisible = normalizeBoolean(body.isHomepageVisible, true);
  if (Object.prototype.hasOwnProperty.call(body, 'homepageFeatured')) {
    payload.homepageFeatured = normalizeBoolean(body.homepageFeatured);
    payload.isFeatured = payload.homepageFeatured;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isFeatured')) payload.isFeatured = normalizeBoolean(body.isFeatured);
  if (Object.prototype.hasOwnProperty.call(body, 'isFeaturedHomepage')) payload.isFeatured = normalizeBoolean(body.isFeaturedHomepage);
  if (payload.isFeatured === true && !Object.prototype.hasOwnProperty.call(payload, 'homepageFeatured')) payload.homepageFeatured = true;
  if (payload.isFeatured === false && !Object.prototype.hasOwnProperty.call(payload, 'homepageFeatured')) payload.homepageFeatured = false;
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    const parsed = Number(body.sortOrder);
    payload.sortOrder = Number.isFinite(parsed) ? parsed : 0;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'publishedAt')) payload.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;

  if (!partial && !payload.title) {
    const error = new Error('title is required');
    error.status = 400;
    throw error;
  }

  return payload;
}

async function getViralVideosSettings(_req, res, next) {
  try {
    const settings = await readViralVideosSettings();
    return res.status(200).json({ ok: true, settings });
  } catch (error) {
    return next(error);
  }
}

async function updateViralVideosSettings(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof body.frontendEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'frontendEnabled boolean is required' });
    }

    const frontendEnabled = body.frontendEnabled;

    const settings = await saveViralVideosSettings({ frontendEnabled }, req.admin);
    return res.status(200).json({ ok: true, settings });
  } catch (error) {
    return next(error);
  }
}

async function listAdminViralVideos(req, res, next) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, items: [], page: 1, limit: 0, total: 0, totalPages: 1 });
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = buildListFilter(req.query);
    const [items, total] = await Promise.all([
      ViralVideo.find(filter).sort(buildListSort(req.query)).skip((page - 1) * limit).limit(limit).lean(),
      ViralVideo.countDocuments(filter),
    ]);
    return res.status(200).json({ ok: true, items: (items || []).map(toAdminViralVideoDto), page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) });
  } catch (error) {
    return next(error);
  }
}

async function createAdminViralVideo(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });
    const doc = await ViralVideo.create(buildViralVideoPayload(req.body));
    return res.status(201).json({ ok: true, item: toAdminViralVideoDto(doc) });
  } catch (error) {
    return res.status(typeof error.status === 'number' ? error.status : 500).json({ ok: false, message: error.message || 'Failed to create viral video' });
  }
}

async function findAdminViralVideoByIdParam(id) {
  if (mongoose.Types.ObjectId.isValid(String(id))) return ViralVideo.findById(id).lean();
  return ViralVideo.findOne({ slug: String(id || '').trim().toLowerCase() }).lean();
}

async function getAdminViralVideoById(req, res, next) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });
    const item = await findAdminViralVideoByIdParam(req.params.id);
    if (!item) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    return res.status(200).json({ ok: true, item: toAdminViralVideoDto(item) });
  } catch (error) {
    return next(error);
  }
}

async function updateAdminViralVideo(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });
    const query = mongoose.Types.ObjectId.isValid(String(req.params.id)) ? { _id: req.params.id } : { slug: String(req.params.id || '').trim().toLowerCase() };
    const doc = await ViralVideo.findOneAndUpdate(query, { $set: buildViralVideoPayload(req.body, { partial: true }) }, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    return res.status(200).json({ ok: true, item: toAdminViralVideoDto(doc) });
  } catch (error) {
    return res.status(typeof error.status === 'number' ? error.status : 500).json({ ok: false, message: error.message || 'Failed to update viral video' });
  }
}

async function deleteAdminViralVideo(req, res, next) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });
    const query = mongoose.Types.ObjectId.isValid(String(req.params.id)) ? { _id: req.params.id } : { slug: String(req.params.id || '').trim().toLowerCase() };
    const doc = await ViralVideo.findOneAndDelete(query).lean();
    if (!doc) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    return res.status(200).json({ ok: true, deleted: true, item: toAdminViralVideoDto(doc) });
  } catch (error) {
    return next(error);
  }
}

function pickUploadedVideo(req) {
  if (req.file) return req.file;
  if (Array.isArray(req.files)) {
    const preferred = req.files.find((file) => ['video', 'file', 'media'].includes(String(file?.fieldname || '').toLowerCase()));
    return preferred || req.files[0] || null;
  }
  if (req.files && typeof req.files === 'object') {
    for (const fieldName of ['video', 'file', 'media']) {
      const files = req.files[fieldName];
      if (Array.isArray(files) && files[0]) return files[0];
    }
  }
  return null;
}

async function uploadViralVideoFile(req, res) {
  return viralVideoUpload.any()(req, res, async (err) => {
    let uploaded = null;
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, message: 'File too large (max 250MB)' });
        return res.status(typeof err.status === 'number' ? err.status : 400).json({ ok: false, message: err.message || 'Upload failed' });
      }
      const file = pickUploadedVideo(req);
      if (!file) return res.status(400).json({ ok: false, message: 'No file uploaded (field: video | file | media)' });
      uploaded = await mediaLibraryStorage.uploadMediaLibraryFile(req, file);
      const mediaRecord = await mediaLibraryService.createIndexedMediaRecord(req, uploaded, { source: 'admin-viral-videos', mediaType: 'video' });
      return res.status(200).json({
        ok: true,
        message: 'Viral video uploaded successfully',
        uploadedVideo: {
          storageId: mediaRecord.storageId || null,
          fileName: mediaRecord.fileName || null,
          originalName: mediaRecord.originalName || null,
          mimeType: mediaRecord.mimeType || null,
          provider: mediaRecord.provider || null,
          relativeUrl: mediaRecord.relativeUrl || null,
          url: mediaRecord.playbackUrl || mediaRecord.assetUrl || mediaRecord.url || null,
          size: typeof mediaRecord.size === 'number' ? mediaRecord.size : 0,
        },
        media: mediaRecord,
      });
    } catch (error) {
      if (uploaded && uploaded.id) {
        try { await mediaLibraryStorage.deleteMediaLibraryItem(uploaded.id); } catch (_) {}
      }
      return res.status(typeof error?.status === 'number' ? error.status : 500).json({ ok: false, code: error?.code || undefined, message: error?.message || 'Upload failed' });
    }
  });
}

module.exports = {
  getViralVideosSettings,
  updateViralVideosSettings,
  listAdminViralVideos,
  createAdminViralVideo,
  getAdminViralVideoById,
  updateAdminViralVideo,
  deleteAdminViralVideo,
  uploadViralVideoFile,
};
