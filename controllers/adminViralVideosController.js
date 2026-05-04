const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');

const ViralVideo = require('../models/ViralVideo');
const { handleCoverImageUpload } = require('../routes/uploads.routes');
const cloudinaryUploads = require('../lib/cloudinary');
const {
  getViralVideosSettings: readViralVideosSettings,
  saveViralVideosSettings,
} = require('../lib/viralVideosSettings');

const CLOUD_VIDEO_UPLOAD_NOT_CONNECTED_MESSAGE = 'Cloud video upload is not connected yet. Use Video URL for now.';
const CLOUD_VIDEO_UPLOAD_DISABLED_MESSAGE = 'Cloud video upload is available but disabled. Use Video URL unless enabled.';
const CLOUD_VIDEO_UPLOAD_READY_MESSAGE = 'Cloud video upload is ready.';
const CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE = 'Cloudinary video upload is not configured on backend.';
const CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE = 'Cloudinary video upload failed.';
const IMAGE_UPLOAD_NOT_CONFIGURED_MESSAGE = 'Image upload is not configured in this environment. Paste an image URL to continue.';
const THUMBNAIL_IMAGE_TYPE_NOT_ALLOWED_MESSAGE = 'Only JPG, JPEG, PNG, or WEBP thumbnail images are allowed.';
const VIDEO_FILE_MISSING_MESSAGE = 'No video file received. Please select an MP4, WebM, or MOV file.';
const VIDEO_UPLOAD_TYPE_NOT_ALLOWED_MESSAGE = 'Only MP4, WebM, or MOV videos are allowed.';
const VIDEO_UPLOAD_TOO_LARGE_MESSAGE = 'Video file is too large. Please upload below 100MB.';
const VIDEO_UPLOAD_FAILED_MESSAGE = 'Video upload failed';
const VIRAL_VIDEO_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const VIRAL_VIDEO_ACCEPTED_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const VIRAL_VIDEO_ACCEPTED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const VIRAL_VIDEO_UPLOAD_FIELD_NAMES = ['video', 'videoFile', 'file'];

function normalizeSourceType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'url';
  if (raw === 'uploaded' || raw === 'file' || raw === 'cloud') return 'upload';
  if (raw === 'upload') return 'upload';
  return 'url';
}

const viralVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIRAL_VIDEO_MAX_UPLOAD_BYTES },
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

function isUploadedVideoUrl(value) {
  const raw = String(value || '').trim().split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|webm|mov)$/.test(raw) || raw.startsWith('/uploads/') || raw.startsWith('uploads/');
}

function isYouTubeUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\//.test(raw);
}

function isXStatusUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /(^|\/\/)(www\.)?(x\.com|twitter\.com)\/(i\/status\/|[^/?#]+\/status\/)[^/?#]+/.test(raw);
}

function resolveVideoContract(payload) {
  const suppliedVideoUrl = payload.videoUrl || payload.videoFileUrl || payload.embedUrl || payload.sourceUrl || null;
  const requestedVideoType = String(payload.videoType || '').trim().toLowerCase();
  const requestedPlaybackMode = String(payload.playbackMode || '').trim().toLowerCase();

  if (payload.videoFileUrl || payload.sourceType === 'upload' || requestedVideoType === 'uploaded' || isUploadedVideoUrl(suppliedVideoUrl)) {
    const fileUrl = payload.videoFileUrl || payload.videoUrl || suppliedVideoUrl;
    payload.videoFileUrl = fileUrl || null;
    payload.videoUrl = fileUrl || payload.videoUrl || null;
    payload.videoType = 'uploaded';
    payload.playbackMode = 'internal';
    payload.sourceType = 'upload';
    return;
  }

  if (requestedVideoType === 'youtube' || requestedPlaybackMode === 'embed' || isYouTubeUrl(suppliedVideoUrl)) {
    payload.videoType = 'youtube';
    payload.playbackMode = 'embed';
    payload.sourceType = 'url';
    if (!payload.embedUrl) payload.embedUrl = suppliedVideoUrl;
    if (!payload.videoUrl) payload.videoUrl = suppliedVideoUrl;
    if (!payload.sourceUrl && payload.videoUrl) payload.sourceUrl = payload.videoUrl;
    return;
  }

  if (requestedVideoType === 'x' || requestedPlaybackMode === 'x_embed' || isXStatusUrl(suppliedVideoUrl)) {
    const xUrl = payload.videoUrl || payload.sourceUrl || payload.embedUrl || suppliedVideoUrl;
    payload.videoType = 'x';
    payload.playbackMode = 'x_embed';
    payload.sourceType = 'url';
    payload.videoUrl = xUrl || payload.videoUrl || null;
    payload.sourceUrl = xUrl || payload.sourceUrl || null;
    payload.sourceName = 'X';
    return;
  }

  payload.videoType = 'external';
  payload.playbackMode = 'external';
  payload.sourceType = 'url';
  if (!payload.sourceUrl && suppliedVideoUrl) payload.sourceUrl = suppliedVideoUrl;
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function logViralVideosCreateFailure(error) {
  try {
    // eslint-disable-next-line no-console
    console.error('[viral-videos][admin-create-failed]', {
      message: error?.message || String(error),
      ...(error?.name ? { name: error.name } : {}),
      ...(error?.code ? { code: error.code } : {}),
      ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    });
  } catch (_) {}
}

function hasEnv(name) {
  return !!String(process.env[name] || '').trim();
}

function hasCloudinaryConfig() {
  try {
    return cloudinaryUploads.getCloudinaryConfigStatus().configured === true;
  } catch (_) {
    return (hasEnv('CLOUDINARY_CLOUD_NAME') && hasEnv('CLOUDINARY_API_KEY') && hasEnv('CLOUDINARY_API_SECRET')) || hasEnv('CLOUDINARY_URL');
  }
}

function getCloudinaryVideoConfigStatus() {
  try {
    return cloudinaryUploads.getCloudinaryConfigStatus();
  } catch (_) {
    const cloudNamePresent = hasEnv('CLOUDINARY_CLOUD_NAME');
    const apiKeyPresent = hasEnv('CLOUDINARY_API_KEY');
    const apiSecretPresent = hasEnv('CLOUDINARY_API_SECRET');
    const cloudinaryUrlPresent = hasEnv('CLOUDINARY_URL');
    return {
      configured: (cloudNamePresent && apiKeyPresent && apiSecretPresent) || cloudinaryUrlPresent,
      mode: cloudNamePresent && apiKeyPresent && apiSecretPresent ? 'keys' : (cloudinaryUrlPresent ? 'url' : 'missing'),
      missing: [
        ...(!cloudNamePresent ? ['CLOUDINARY_CLOUD_NAME'] : []),
        ...(!apiKeyPresent ? ['CLOUDINARY_API_KEY'] : []),
        ...(!apiSecretPresent ? ['CLOUDINARY_API_SECRET'] : []),
      ],
      env: { cloudNamePresent, apiKeyPresent, apiSecretPresent, cloudinaryUrlPresent },
    };
  }
}

function sanitizeCloudinaryMessageText(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const secretValues = [
    process.env.CLOUDINARY_API_SECRET,
    process.env.CLOUDINARY_API_KEY,
    process.env.CLOUDINARY_URL,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  let message = raw;
  for (const value of secretValues) {
    message = message.split(value).join('[redacted]');
  }

  return message.slice(0, 500);
}

function sanitizeCloudinaryProviderMessage(error) {
  return sanitizeCloudinaryMessageText(error?.error?.message) || sanitizeCloudinaryMessageText(error?.message) || 'Cloudinary upload failed';
}

function buildSafeCloudinaryErrorDetails(error) {
  const errorMessage = sanitizeCloudinaryMessageText(error?.message);
  const nestedErrorMessage = sanitizeCloudinaryMessageText(error?.error?.message);
  return {
    providerMessage: sanitizeCloudinaryProviderMessage(error),
    ...(errorMessage ? { errorMessage } : {}),
    ...(nestedErrorMessage ? { nestedErrorMessage } : {}),
    ...(typeof error?.http_code === 'number' ? { httpCode: error.http_code } : {}),
    ...(error?.name ? { errorName: String(error.name).slice(0, 100) } : {}),
  };
}

function logViralVideoCloudinaryUpload(event, details = {}) {
  try {
    // eslint-disable-next-line no-console
    console.error(`[viral-videos][cloudinary-video-upload][${event}]`, details);
  } catch (_) {}
}

function buildViralVideoCloudinaryDiagnostics(cloudinaryConfig, file) {
  return {
    cloudinaryConfigPresent: cloudinaryConfig.configured === true,
    cloudinaryCloudNamePresent: cloudinaryConfig.env?.cloudNamePresent === true,
    cloudinaryApiKeyPresent: cloudinaryConfig.env?.apiKeyPresent === true,
    cloudinaryApiSecretPresent: cloudinaryConfig.env?.apiSecretPresent === true,
    provider: 'CLOUDINARY',
    resource_type: 'video',
    file: {
      fieldName: file ? String(file.fieldname || '') || null : null,
      originalFilename: file ? String(file.originalname || '').slice(0, 200) || null : null,
      mimetype: file ? String(file.mimetype || '').trim().toLowerCase() || null : null,
      size: file && typeof file.size === 'number' ? file.size : null,
    },
  };
}

function resolveVideoUploadProvider() {
  if (hasCloudinaryConfig()) return { available: true, provider: 'cloudinary' };

  const hasS3 = hasEnv('AWS_ACCESS_KEY_ID')
    && hasEnv('AWS_SECRET_ACCESS_KEY')
    && (hasEnv('AWS_S3_BUCKET') || hasEnv('S3_BUCKET') || hasEnv('AWS_BUCKET_NAME'))
    && (hasEnv('AWS_REGION') || hasEnv('AWS_DEFAULT_REGION'));
  if (hasS3) return { available: true, provider: 's3' };

  const hasR2 = (hasEnv('R2_ACCESS_KEY_ID') || hasEnv('CLOUDFLARE_R2_ACCESS_KEY_ID'))
    && (hasEnv('R2_SECRET_ACCESS_KEY') || hasEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY'))
    && (hasEnv('R2_BUCKET') || hasEnv('CLOUDFLARE_R2_BUCKET'))
    && (hasEnv('R2_ENDPOINT') || hasEnv('CLOUDFLARE_R2_ENDPOINT') || hasEnv('CLOUDFLARE_ACCOUNT_ID'));
  if (hasR2) return { available: true, provider: 'r2' };

  return { available: false, provider: null };
}

function buildViralVideosCloudUploadCapability(settings = {}) {
  const provider = resolveVideoUploadProvider();
  const enabled = settings.viralVideosCloudUploadEnabled === true
    || (settings.__viralVideosCloudUploadEnabledExplicit !== true && provider.available === true);
  const available = provider.available === true;

  return {
    enabled,
    available,
    provider: provider.provider,
    message: available
      ? (enabled ? CLOUD_VIDEO_UPLOAD_READY_MESSAGE : CLOUD_VIDEO_UPLOAD_DISABLED_MESSAGE)
      : CLOUD_VIDEO_UPLOAD_NOT_CONNECTED_MESSAGE,
  };
}

function withViralVideosCapabilities(settings) {
  const viralVideosCloudUpload = buildViralVideosCloudUploadCapability(settings);
  return {
    ...settings,
    viralVideosCloudUploadAvailable: viralVideosCloudUpload.available === true,
    viralVideosCloudUpload,
  };
}

function buildViralVideosSettingsResponse(settings) {
  const responseSettings = withViralVideosCapabilities(settings);
  return {
    ok: true,
    settings: responseSettings,
    viralVideosCloudUploadEnabled: responseSettings.viralVideosCloudUploadEnabled === true,
    viralVideosCloudUploadAvailable: responseSettings.viralVideosCloudUploadAvailable === true,
    viralVideosCloudUpload: responseSettings.viralVideosCloudUpload,
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
    sourceName: source.sourceName || null,
    sourceUrl: source.sourceUrl || null,
    thumbnailUrl: source.thumbnailUrl || source.posterImageUrl || source.posterImage?.url || null,
    posterImageUrl: source.posterImageUrl || source.thumbnailUrl || source.posterImage?.url || null,
    posterImage: normalizePosterImage(source.posterImage),
    thumbnail: normalizePosterImage(source.posterImage),
    videoUrl: source.videoUrl || null,
    videoFileUrl: source.videoFileUrl || null,
    embedUrl: source.embedUrl || null,
    videoType: source.videoType || null,
    playbackMode: source.playbackMode || null,
    sourceType: normalizeSourceType(source.sourceType),
    videoStorageProvider: source.videoStorageProvider || null,
    videoPublicId: source.videoPublicId || null,
    videoKey: source.videoKey || null,
    videoMimeType: source.videoMimeType || null,
    videoSizeBytes: typeof source.videoSizeBytes === 'number' ? source.videoSizeBytes : null,
    videoDuration: typeof source.videoDuration === 'number' ? source.videoDuration : null,
    language: source.language || 'en',
    category: source.category || null,
    tags: Array.isArray(source.tags) ? source.tags : [],
    isActive: source.isActive !== false,
    globalFrontend: source.globalFrontend !== false,
    isPublished: source.isPublished === true,
    status: source.status || (source.isPublished === true ? 'published' : 'draft'),
    isHomepageVisible: source.isHomepageVisible !== false,
    showOnHomepage: source.isHomepageVisible !== false,
    homepageFeatured: source.homepageFeatured === true || source.isFeatured === true,
    isFeatured: source.isFeatured === true,
    isFeaturedHomepage: source.isFeatured === true,
    publishedAt: source.publishedAt || null,
    sortOrder: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
    priority: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
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
  assignString('sourceName');
  assignString('sourceUrl');
  assignString('thumbnailUrl');
  assignString('posterImageUrl');
  assignString('videoUrl');
  assignString('videoFileUrl');
  assignString('embedUrl');
  assignString('language');
  assignString('category');
  if (Object.prototype.hasOwnProperty.call(body, 'sourceType')) payload.sourceType = normalizeSourceType(body.sourceType);
  if (Object.prototype.hasOwnProperty.call(body, 'videoType')) payload.videoType = normalizeOptionalString(body.videoType);
  if (Object.prototype.hasOwnProperty.call(body, 'playbackMode')) payload.playbackMode = normalizeOptionalString(body.playbackMode);
  assignString('videoStorageProvider');
  assignString('videoPublicId');
  assignString('videoKey');
  assignString('videoMimeType');
  if (Object.prototype.hasOwnProperty.call(body, 'videoSizeBytes')) payload.videoSizeBytes = normalizeOptionalNumber(body.videoSizeBytes);
  if (Object.prototype.hasOwnProperty.call(body, 'videoDuration')) payload.videoDuration = normalizeOptionalNumber(body.videoDuration);
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) payload.tags = normalizeStringArray(body.tags);
  if (Object.prototype.hasOwnProperty.call(body, 'isActive')) payload.isActive = normalizeBoolean(body.isActive, true);
  if (Object.prototype.hasOwnProperty.call(body, 'posterImage')) payload.posterImage = normalizePosterImage(body.posterImage);
  if (Object.prototype.hasOwnProperty.call(body, 'thumbnail')) payload.posterImage = normalizePosterImage(body.thumbnail);
  if (Object.prototype.hasOwnProperty.call(body, 'thumbnailUrl')) {
    const thumbnailUrl = normalizeOptionalString(body.thumbnailUrl);
    payload.thumbnailUrl = thumbnailUrl;
    if (thumbnailUrl && !payload.posterImageUrl) payload.posterImageUrl = thumbnailUrl;
    if (!payload.posterImage && thumbnailUrl) payload.posterImage = { url: thumbnailUrl, publicId: null, alt: null };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'posterImageUrl')) {
    const posterImageUrl = normalizeOptionalString(body.posterImageUrl);
    payload.posterImageUrl = posterImageUrl;
    if (posterImageUrl && !payload.thumbnailUrl) payload.thumbnailUrl = posterImageUrl;
    if (!payload.posterImage && posterImageUrl) payload.posterImage = { url: posterImageUrl, publicId: null, alt: null };
  }
  if (payload.posterImage && payload.posterImage.url && !payload.thumbnailUrl) payload.thumbnailUrl = payload.posterImage.url;
  if (payload.posterImage && payload.posterImage.url && !payload.posterImageUrl) payload.posterImageUrl = payload.posterImage.url;
  if (Object.prototype.hasOwnProperty.call(body, 'globalFrontend')) payload.globalFrontend = normalizeBoolean(body.globalFrontend, true);
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = String(body.status || '').trim().toLowerCase() === 'published' ? 'published' : 'draft';
    payload.status = status;
    payload.isPublished = status === 'published';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isPublished')) payload.isPublished = normalizeBoolean(body.isPublished);
  if (payload.isPublished === true && !payload.status) payload.status = 'published';
  if (payload.isPublished === false && !payload.status) payload.status = 'draft';
  if (Object.prototype.hasOwnProperty.call(body, 'isHomepageVisible')) payload.isHomepageVisible = normalizeBoolean(body.isHomepageVisible, true);
  if (Object.prototype.hasOwnProperty.call(body, 'showOnHomepage')) payload.isHomepageVisible = normalizeBoolean(body.showOnHomepage, true);
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
  if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
    const parsed = Number(body.priority);
    payload.sortOrder = Number.isFinite(parsed) ? parsed : 0;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'publishedAt')) payload.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
  if (payload.isPublished === true && !Object.prototype.hasOwnProperty.call(payload, 'publishedAt')) payload.publishedAt = new Date();

  const hasVideoContractInput = [
    'videoUrl',
    'videoFileUrl',
    'embedUrl',
    'sourceUrl',
    'sourceType',
    'videoType',
    'playbackMode',
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (!partial || hasVideoContractInput) resolveVideoContract(payload);

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
    return res.status(200).json(buildViralVideosSettingsResponse(settings));
  } catch (error) {
    return next(error);
  }
}

async function updateViralVideosSettings(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const hasViralVideosFrontendEnabled = Object.prototype.hasOwnProperty.call(body, 'viralVideosFrontendEnabled');
    const hasFrontendEnabled = Object.prototype.hasOwnProperty.call(body, 'frontendEnabled');
    const hasCloudUploadEnabled = Object.prototype.hasOwnProperty.call(body, 'viralVideosCloudUploadEnabled');

    if (!hasViralVideosFrontendEnabled && !hasFrontendEnabled && !hasCloudUploadEnabled) {
      return res.status(400).json({ ok: false, message: 'At least one Viral Videos setting is required' });
    }
    if (hasViralVideosFrontendEnabled && typeof body.viralVideosFrontendEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'viralVideosFrontendEnabled boolean is required' });
    }
    if (hasFrontendEnabled && typeof body.frontendEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'frontendEnabled boolean is required' });
    }
    if (hasCloudUploadEnabled && typeof body.viralVideosCloudUploadEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, message: 'viralVideosCloudUploadEnabled boolean is required' });
    }

    const current = await readViralVideosSettings();
    const nextFrontendEnabled = hasViralVideosFrontendEnabled
      ? body.viralVideosFrontendEnabled
      : (hasFrontendEnabled ? body.frontendEnabled : current.viralVideosFrontendEnabled);
    const settings = await saveViralVideosSettings({
      ...current,
      viralVideosFrontendEnabled: nextFrontendEnabled,
      frontendEnabled: nextFrontendEnabled,
      ...(hasCloudUploadEnabled ? { viralVideosCloudUploadEnabled: body.viralVideosCloudUploadEnabled } : {}),
    }, req.admin);

    return res.status(200).json(buildViralVideosSettingsResponse(settings));
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
    logViralVideosCreateFailure(error);
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

async function previewAdminViralVideo(req, res, next) {
  return getAdminViralVideoById(req, res, next);
}

async function publishAdminViralVideo(req, res) {
  const nextBody = {
    ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}),
    status: 'published',
    isPublished: true,
    publishedAt: new Date(),
  };
  req.body = nextBody;
  return updateAdminViralVideo(req, res);
}

async function unpublishAdminViralVideo(req, res) {
  const nextBody = {
    ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}),
    status: 'draft',
    isPublished: false,
  };
  req.body = nextBody;
  return updateAdminViralVideo(req, res);
}

async function updateAdminViralVideoStatus(req, res) {
  return updateAdminViralVideo(req, res);
}

function getUploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files.filter(Boolean);
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat().filter(Boolean);
  return [];
}

function selectViralVideoUploadFile(files) {
  const uploadedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  for (const fieldName of VIRAL_VIDEO_UPLOAD_FIELD_NAMES) {
    const match = uploadedFiles.find((file) => String(file?.fieldname || '') === fieldName);
    if (match) return match;
  }
  return uploadedFiles.find(Boolean) || null;
}

function isVideoUploadAttempt(file) {
  return String(file?.mimetype || '').toLowerCase().startsWith('video/');
}

function hasAcceptedViralVideoExtension(file) {
  const extension = path.extname(String(file?.originalname || '')).trim().toLowerCase();
  return VIRAL_VIDEO_ACCEPTED_EXTENSIONS.has(extension);
}

function isLikelyVideoUpload(file) {
  return isVideoUploadAttempt(file) || hasAcceptedViralVideoExtension(file);
}

function getViralVideoUploadFolder() {
  const folder = String(process.env.CLOUDINARY_VIRAL_VIDEOS_FOLDER || 'newspulse/viral-videos').trim();
  return folder || 'newspulse/viral-videos';
}

function assertAllowedViralVideoFile(file) {
  const mimeType = String(file?.mimetype || '').trim().toLowerCase();
  const extension = path.extname(String(file?.originalname || '')).trim().toLowerCase();

  if (!VIRAL_VIDEO_ACCEPTED_MIME_TYPES.has(mimeType) || !VIRAL_VIDEO_ACCEPTED_EXTENSIONS.has(extension)) {
    const error = new Error(VIDEO_UPLOAD_TYPE_NOT_ALLOWED_MESSAGE);
    error.status = 400;
    error.code = 'INVALID_VIDEO_TYPE';
    throw error;
  }

  return { mimeType, extension };
}

function toStableViralVideoUploadResponse(result, file, capability) {
  const secureUrl = result?.secure_url || result?.url || null;
  if (!secureUrl) {
    const error = new Error(VIDEO_UPLOAD_FAILED_MESSAGE);
    error.code = 'CLOUDINARY_UPLOAD_FAILED';
    throw error;
  }

  return {
    ok: true,
    enabled: capability?.enabled === true,
    provider: capability?.provider || null,
    message: capability?.message || CLOUD_VIDEO_UPLOAD_READY_MESSAGE,
    url: secureUrl,
    secure_url: secureUrl,
    secureUrl,
    resource_type: 'video',
    public_id: result?.public_id || null,
    publicId: result?.public_id || null,
    videoUrl: secureUrl,
    videoFileUrl: secureUrl,
    videoStorageProvider: 'cloudinary',
    videoPublicId: result?.public_id || null,
    videoMimeType: String(file?.mimetype || '').trim().toLowerCase() || null,
    videoSizeBytes: typeof file?.size === 'number' ? file.size : null,
    viralVideosCloudUploadAvailable: true,
    viralVideosCloudUpload: capability,
  };
}

async function uploadViralVideoThumbnailFile(req, res) {
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let statusCode = 200;

  res.status = (code) => {
    statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.status = originalStatus;
    res.json = originalJson;

    if (!body || body.ok !== true) {
      return originalStatus(statusCode).json(body);
    }

    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const thumbnailUrl = body.thumbnailUrl || body.url || body.secureUrl || body.secure_url || data.url || data.secureUrl || data.secure_url || null;
    const publicId = body.publicId || body.public_id || data.publicId || data.public_id || null;
    const posterImage = { url: thumbnailUrl, publicId, alt: null };

    return originalStatus(statusCode).json({
      ...body,
      message: body.message || 'Viral video thumbnail uploaded successfully',
      thumbnailUrl,
      posterImage,
      thumbnail: posterImage,
      data: {
        ...data,
        url: thumbnailUrl,
        secureUrl: thumbnailUrl,
        secure_url: thumbnailUrl,
        publicId,
        public_id: publicId,
      },
    });
  };

  try {
    return await handleCoverImageUpload(req, res, {
      notConfiguredMessage: IMAGE_UPLOAD_NOT_CONFIGURED_MESSAGE,
      validationMessage: THUMBNAIL_IMAGE_TYPE_NOT_ALLOWED_MESSAGE,
    });
  } catch (error) {
    res.status = originalStatus;
    res.json = originalJson;
    throw error;
  }
}

async function handleViralVideoUploadRequest(req, res, file) {
  if (!file) return res.status(400).json({ ok: false, code: 'VIDEO_FILE_MISSING', message: VIDEO_FILE_MISSING_MESSAGE });

  if (isLikelyVideoUpload(file)) {
    assertAllowedViralVideoFile(file);
  } else {
    return res.status(400).json({ ok: false, code: 'INVALID_VIDEO_TYPE', message: VIDEO_UPLOAD_TYPE_NOT_ALLOWED_MESSAGE });
  }

  const settings = await readViralVideosSettings();
  const capability = buildViralVideosCloudUploadCapability(settings);
  const cloudinaryConfig = getCloudinaryVideoConfigStatus();
  const uploadDiagnostics = buildViralVideoCloudinaryDiagnostics(cloudinaryConfig, file);
  if (capability.available !== true) {
    logViralVideoCloudinaryUpload('config-missing', {
      ...uploadDiagnostics,
      missing: Array.isArray(cloudinaryConfig.missing) ? cloudinaryConfig.missing : [],
    });
    return res.status(500).json({
      ok: false,
      code: 'CLOUDINARY_CONFIG_MISSING',
      enabled: capability.enabled === true,
      provider: 'cloudinary',
      message: CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE,
      viralVideosCloudUploadAvailable: false,
      viralVideosCloudUpload: capability,
    });
  }
  if (capability.enabled !== true) {
    return res.status(400).json({
      ok: false,
      code: 'CLOUDINARY_UPLOAD_DISABLED',
      enabled: capability.enabled === true,
      provider: capability.provider,
      message: CLOUD_VIDEO_UPLOAD_DISABLED_MESSAGE,
      viralVideosCloudUploadAvailable: true,
      viralVideosCloudUpload: capability,
    });
  }
  if (cloudinaryConfig.configured !== true) {
    logViralVideoCloudinaryUpload('config-missing', {
      ...uploadDiagnostics,
      missing: Array.isArray(cloudinaryConfig.missing) ? cloudinaryConfig.missing : [],
    });
    return res.status(500).json({
      ok: false,
      code: 'CLOUDINARY_CONFIG_MISSING',
      enabled: capability.enabled === true,
      provider: 'cloudinary',
      message: CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE,
      viralVideosCloudUploadAvailable: false,
      viralVideosCloudUpload: {
        ...capability,
        available: false,
        provider: 'cloudinary',
        message: CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE,
      },
    });
  }

  try {
    logViralVideoCloudinaryUpload('upload-stream-start', uploadDiagnostics);
    const uploaded = await cloudinaryUploads.uploadFromBuffer(file.buffer, {
      folder: getViralVideoUploadFolder(),
      resourceType: 'video',
    });
    logViralVideoCloudinaryUpload('upload-stream-success', {
      ...uploadDiagnostics,
      secureUrlPresent: !!(uploaded?.secure_url || uploaded?.url),
      publicIdPresent: !!uploaded?.public_id,
    });
    return res.status(200).json(toStableViralVideoUploadResponse(uploaded, file, capability));
  } catch (uploadError) {
    const safeCloudinaryError = buildSafeCloudinaryErrorDetails(uploadError);
    logViralVideoCloudinaryUpload('upload-stream-error', {
      ...uploadDiagnostics,
      ...safeCloudinaryError,
      ...(uploadError?.code ? { providerCode: String(uploadError.code).slice(0, 100) } : {}),
    });
    return res.status(400).json({
      ok: false,
      code: 'CLOUDINARY_UPLOAD_FAILED',
      message: CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE,
      providerMessage: safeCloudinaryError.providerMessage,
      error: safeCloudinaryError.providerMessage,
      errorMessage: safeCloudinaryError.providerMessage,
      reason: safeCloudinaryError.providerMessage,
      details: {
        providerMessage: safeCloudinaryError.providerMessage,
      },
    });
  }
}

async function uploadViralVideoFile(req, res) {
  return viralVideoUpload.any()(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, message: VIDEO_UPLOAD_TOO_LARGE_MESSAGE, code: 'VIDEO_FILE_TOO_LARGE' });
        return res.status(typeof err.status === 'number' ? err.status : 400).json({ ok: false, message: err.message || 'Upload failed' });
      }
      const files = getUploadedFiles(req);
      const file = selectViralVideoUploadFile(files);
      const cloudinaryConfig = getCloudinaryVideoConfigStatus();
      logViralVideoCloudinaryUpload('route-hit', {
        route: req.originalUrl || req.path,
        authValid: true,
        fileReceived: !!file,
        ...buildViralVideoCloudinaryDiagnostics(cloudinaryConfig, file),
      });
      return await handleViralVideoUploadRequest(req, res, file);
    } catch (error) {
      return res.status(typeof error?.status === 'number' ? error.status : 500).json({ ok: false, code: error?.code || undefined, message: error?.message || 'Upload failed' });
    }
  });
}

async function uploadViralVideoMediaFile(req, res) {
  return viralVideoUpload.any()(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, message: VIDEO_UPLOAD_TOO_LARGE_MESSAGE, code: 'VIDEO_FILE_TOO_LARGE' });
        return res.status(typeof err.status === 'number' ? err.status : 400).json({ ok: false, message: err.message || 'Upload failed' });
      }

      const files = getUploadedFiles(req);
      const file = files.find(Boolean);
      if (!file) return res.status(400).json({ ok: false, message: "No file received. Use multipart field 'cover' (or 'file')." });

      if (isLikelyVideoUpload(file)) {
        return await handleViralVideoUploadRequest(req, res, file);
      }

      return await uploadViralVideoThumbnailFile(req, res);
    } catch (error) {
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
  previewAdminViralVideo,
  publishAdminViralVideo,
  unpublishAdminViralVideo,
  updateAdminViralVideoStatus,
  uploadViralVideoThumbnailFile,
  uploadViralVideoFile,
  uploadViralVideoMediaFile,
  buildViralVideosCloudUploadCapability,
};
