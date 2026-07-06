const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');

const ViralVideo = require('../models/ViralVideo');
const { handleCoverImageUpload } = require('../routes/uploads.routes');
const cloudinaryUploads = require('../lib/cloudinary');
const { slugifyUnicode } = require('../lib/slug');
const {
  getViralVideosSettings: readViralVideosSettings,
  saveViralVideosSettings,
} = require('../lib/viralVideosSettings');
const {
  listAllViralVideosFromFile,
  createViralVideoInFile,
  updateViralVideoInFile,
  softDeleteViralVideoInFile,
  countPublishedViralVideosInRange,
  countPublishedViralVideosFromFileInRange,
  getIstTodayDateString,
  getIstDateRange,
  getPublishedAtRangeFromQuery,
  IST_TIMEZONE,
  VIRAL_VIDEO_DAILY_PUBLISH_LIMIT,
} = require('../services/viralVideos.service');

const CLOUD_VIDEO_UPLOAD_NOT_CONNECTED_MESSAGE = 'Cloud video upload is not connected yet. Use Video URL for now.';
const CLOUD_VIDEO_UPLOAD_DISABLED_MESSAGE = 'Cloud video upload is available but disabled. Use Video URL unless enabled.';
const CLOUD_VIDEO_UPLOAD_READY_MESSAGE = 'Cloud video upload is ready.';
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
const VIRAL_VIDEO_THUMBNAIL_FIELD_NAMES = ['thumbnail', 'poster', 'posterImage', 'cover', 'image', 'file'];
const VIRAL_VIDEO_ACCEPTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIRAL_VIDEO_ACCEPTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIRAL_VIDEO_LOCAL_UPLOAD_MESSAGE = 'Viral video uploaded successfully.';
const VIRAL_VIDEO_THUMBNAIL_LOCAL_UPLOAD_MESSAGE = 'Viral video thumbnail uploaded successfully';
const VIRAL_VIDEO_LANDSCAPE_WARNING = 'Landscape video may be cropped in the vertical reel player.';
const DAILY_VIRAL_VIDEO_LIMIT_MESSAGE = 'Daily viral video limit reached. You can save this video as Draft or schedule it for tomorrow.';

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

function isNativeDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1 && mongoose.connection.db;
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

function normalizeVideoFileCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw;
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
  const explicitVideoFileUrl = normalizeVideoFileCandidate(payload.videoFileUrl);
  const playableUrl = normalizeVideoFileCandidate(payload.videoUrl);
  const embedUrl = normalizeVideoFileCandidate(payload.embedUrl);
  const sourceUrl = normalizeVideoFileCandidate(payload.sourceUrl);
  const suppliedVideoUrl = explicitVideoFileUrl || playableUrl || embedUrl || sourceUrl || null;
  const uploadedCandidate = explicitVideoFileUrl || (isUploadedVideoUrl(playableUrl) ? playableUrl : null);
  const requestedVideoType = String(payload.videoType || '').trim().toLowerCase();
  const requestedPlaybackMode = String(payload.playbackMode || '').trim().toLowerCase();

  if (uploadedCandidate || requestedVideoType === 'uploaded') {
    if (!uploadedCandidate) {
      payload.videoType = 'external';
      payload.playbackMode = 'external';
      payload.sourceType = 'url';
      if (!payload.sourceUrl && suppliedVideoUrl) payload.sourceUrl = suppliedVideoUrl;
      return;
    }

    payload.videoFileUrl = uploadedCandidate;
    payload.videoUrl = uploadedCandidate;
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

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeViralStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'draft' || raw === 'published' || raw === 'unpublished' || raw === 'archived') return raw;
  if (raw === 'scheduled') return 'draft';
  throw badRequest('status must be draft, published, unpublished, or archived');
}

function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${fieldName} must be a valid date`);
  return date;
}

function buildDailyCountResponse(publishedCount, date = getIstTodayDateString()) {
  const remaining = Math.max(VIRAL_VIDEO_DAILY_PUBLISH_LIMIT - publishedCount, 0);
  return {
    date,
    timezone: IST_TIMEZONE,
    publishedCount,
    limit: VIRAL_VIDEO_DAILY_PUBLISH_LIMIT,
    remaining,
  };
}

async function getTodayPublishedCount(excludeIdOrSlug = null) {
  const date = getIstTodayDateString();
  const range = getIstDateRange(date);
  if (isNativeDbReady()) {
    return buildDailyCountResponse(await countPublishedViralVideosInRange(range, excludeIdOrSlug), date);
  }
  return buildDailyCountResponse(await countPublishedViralVideosFromFileInRange(range, excludeIdOrSlug), date);
}

async function assertDailyPublishLimitAvailable(excludeIdOrSlug = null) {
  const stats = await getTodayPublishedCount(excludeIdOrSlug);
  if (stats.publishedCount >= stats.limit) {
    const error = badRequest(DAILY_VIRAL_VIDEO_LIMIT_MESSAGE);
    error.code = 'DAILY_VIRAL_VIDEO_LIMIT_REACHED';
    error.dailyLimit = stats;
    throw error;
  }
  return stats;
}

function getAdminDisplayName(req) {
  const admin = req && req.admin && typeof req.admin === 'object' ? req.admin : {};
  return normalizeOptionalString(admin.name) || normalizeOptionalString(admin.email) || normalizeOptionalString(admin.role) || 'Admin';
}

async function buildUniqueViralSlug(title, requestedSlug = null, excludeId = null) {
  const base = slugifyUnicode(requestedSlug || title) || `viral-video-${crypto.randomBytes(3).toString('hex')}`;
  if (!mongoose.connection || !mongoose.connection.db) return base;
  let slug = base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await ViralVideo.findOne({ slug }).select('_id').lean();
    if (!existing || (excludeId && String(existing._id) === String(excludeId))) return slug;
    slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
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
    description: source.description || source.summary || null,
    summary: source.summary || source.description || null,
    shortCaption: source.summary || source.description || null,
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
    duration: source.duration || null,
    language: source.language || 'en',
    category: source.category || 'viral',
    source: source.source || 'News Pulse',
    uploadedBy: source.uploadedBy || null,
    tags: Array.isArray(source.tags) ? source.tags : [],
    isActive: source.isActive !== false,
    globalFrontend: source.globalFrontend !== false,
    isPublished: source.isPublished === true,
    status: source.status || (source.isPublished === true ? 'published' : 'draft'),
    isHomepageVisible: source.isHomepageVisible === true || source.showOnHomepage === true,
    showOnHomepage: source.isHomepageVisible === true || source.showOnHomepage === true,
    homepageFeatured: source.homepageFeatured === true || source.isFeatured === true || source.featured === true,
    isFeatured: source.isFeatured === true || source.featured === true,
    featured: source.isFeatured === true || source.featured === true,
    isFeaturedHomepage: source.isFeatured === true || source.featured === true,
    publishedAt: source.publishedAt || null,
    scheduledAt: source.scheduledAt || null,
    sortOrder: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
    priority: typeof source.sortOrder === 'number' ? source.sortOrder : 0,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function buildListFilter(query = {}) {
  const filter = {};
  const status = String(query.status || '').trim().toLowerCase();
  if (status === 'published' || status === 'draft' || status === 'unpublished' || status === 'archived') filter.status = status;
  if (query.published === 'true' || query.isPublished === 'true') filter.isPublished = true;
  if (query.published === 'false' || query.isPublished === 'false') filter.isPublished = false;
  if (query.lang || query.language) filter.language = String(query.lang || query.language).trim().toLowerCase();
  filter.category = String(query.category || '').trim().toLowerCase() && String(query.category || '').trim().toLowerCase() !== 'viral'
    ? '__no_matching_viral_category__'
    : 'viral';
  if (query.tag) filter.tags = String(query.tag).trim();
  const publishedAtRange = getPublishedAtRangeFromQuery(query);
  if (publishedAtRange) filter.publishedAt = { $gte: publishedAtRange.start, $lt: publishedAtRange.end };
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
  assignString('description');
  assignString('summary');
  assignString('shortCaption', 'summary');
  assignString('duration');
  assignString('uploadedBy');
  assignString('source');
  assignString('sourceName');
  assignString('sourceUrl');
  assignString('thumbnailUrl');
  assignString('posterImageUrl');
  assignString('videoUrl');
  assignString('videoFileUrl');
  assignString('embedUrl');
  assignString('language');
  payload.category = 'viral';
  if (!payload.source) payload.source = 'News Pulse';
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
  if (Object.prototype.hasOwnProperty.call(body, 'scheduledAt')) payload.scheduledAt = parseOptionalDate(body.scheduledAt, 'scheduledAt');
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
    const status = normalizeViralStatus(body.status);
    payload.status = status;
    payload.isPublished = status === 'published';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isPublished')) payload.isPublished = normalizeBoolean(body.isPublished);
  if (payload.isPublished === true && !payload.status) payload.status = 'published';
  if (payload.isPublished === false && !payload.status) payload.status = 'draft';
  if (Object.prototype.hasOwnProperty.call(body, 'isHomepageVisible')) payload.isHomepageVisible = normalizeBoolean(body.isHomepageVisible, true);
  if (Object.prototype.hasOwnProperty.call(body, 'showOnHomepage')) payload.isHomepageVisible = normalizeBoolean(body.showOnHomepage, true);
  if (!partial && !Object.prototype.hasOwnProperty.call(payload, 'isHomepageVisible')) payload.isHomepageVisible = false;
  if (Object.prototype.hasOwnProperty.call(body, 'homepageFeatured')) {
    payload.homepageFeatured = normalizeBoolean(body.homepageFeatured);
    payload.isFeatured = payload.homepageFeatured;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'featured')) {
    payload.featured = normalizeBoolean(body.featured);
    payload.isFeatured = payload.featured;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'isFeatured')) payload.isFeatured = normalizeBoolean(body.isFeatured);
  if (Object.prototype.hasOwnProperty.call(body, 'isFeaturedHomepage')) payload.isFeatured = normalizeBoolean(body.isFeaturedHomepage);
  if (payload.isFeatured === true && !Object.prototype.hasOwnProperty.call(payload, 'homepageFeatured')) payload.homepageFeatured = true;
  if (payload.isFeatured === false && !Object.prototype.hasOwnProperty.call(payload, 'homepageFeatured')) payload.homepageFeatured = false;
  if (!partial && !Object.prototype.hasOwnProperty.call(payload, 'isFeatured')) {
    payload.isFeatured = false;
    payload.homepageFeatured = false;
    payload.featured = false;
  }
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

  if (!partial && !payload.status) {
    payload.status = 'draft';
    payload.isPublished = false;
  }

  if (payload.scheduledAt && payload.scheduledAt > new Date() && payload.status === 'published') {
    payload.status = 'draft';
    payload.isPublished = false;
    payload.publishedAt = null;
  }

  if (payload.status && payload.status !== 'published') {
    payload.isPublished = false;
    if (payload.status === 'archived') payload.isActive = false;
    if (!Object.prototype.hasOwnProperty.call(body, 'publishedAt')) payload.publishedAt = null;
  }

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

  if (payload.description && !payload.summary) payload.summary = payload.description;
  if (payload.summary && !payload.description) payload.description = payload.summary;
  if (!payload.sourceName) payload.sourceName = payload.source || 'News Pulse';

  if (!partial && !payload.title) {
    throw badRequest('title is required');
  }

  if (!partial && !payload.videoUrl) {
    throw badRequest('videoUrl is required');
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
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    if (!isDbReady()) {
      const result = await listAllViralVideosFromFile({ ...req.query, page, limit });
      const items = (result.items || []).map(toAdminViralVideoDto);
      return res.status(200).json({ ok: true, success: true, items, videos: items, page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages });
    }
    const filter = buildListFilter(req.query);
    const [items, total] = await Promise.all([
      ViralVideo.find(filter).sort(buildListSort(req.query)).skip((page - 1) * limit).limit(limit).lean(),
      ViralVideo.countDocuments(filter),
    ]);
    const responseItems = (items || []).map(toAdminViralVideoDto);
    return res.status(200).json({ ok: true, success: true, items: responseItems, videos: responseItems, page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) });
  } catch (error) {
    return next(error);
  }
}

async function getAdminViralVideosDailyCount(_req, res) {
  try {
    const stats = await getTodayPublishedCount();
    return res.status(200).json({ ok: true, success: true, ...stats });
  } catch (error) {
    return res.status(typeof error.status === 'number' ? error.status : 500).json({ ok: false, success: false, message: error.message || 'Failed to read daily viral video count' });
  }
}

async function createAdminViralVideo(req, res) {
  try {
    const payload = buildViralVideoPayload(req.body);
    if (!payload.uploadedBy) payload.uploadedBy = getAdminDisplayName(req);
    payload.category = 'viral';
    payload.source = 'News Pulse';
    payload.sourceName = payload.sourceName || 'News Pulse';

    if (payload.status === 'published') {
      await assertDailyPublishLimitAvailable();
    }

    if (!isDbReady()) {
      const item = toAdminViralVideoDto(await createViralVideoInFile(payload));
      return res.status(201).json({ ok: true, success: true, item, video: item });
    }

    payload.slug = await buildUniqueViralSlug(payload.title);
    const doc = await ViralVideo.create(payload);
    const item = toAdminViralVideoDto(doc);
    return res.status(201).json({ ok: true, success: true, item, video: item });
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
    if (!isDbReady()) {
      const result = await listAllViralVideosFromFile({ limit: 100 });
      const lookup = String(req.params.id || '').trim().toLowerCase();
      const found = (result.items || []).find((item) => String(item.id || item._id).toLowerCase() === lookup || String(item.slug || '').toLowerCase() === lookup);
      if (!found) return res.status(404).json({ ok: false, success: false, message: 'Viral video not found' });
      const item = toAdminViralVideoDto(found);
      return res.status(200).json({ ok: true, success: true, item, video: item });
    }
    const item = await findAdminViralVideoByIdParam(req.params.id);
    if (!item) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    const responseItem = toAdminViralVideoDto(item);
    return res.status(200).json({ ok: true, success: true, item: responseItem, video: responseItem });
  } catch (error) {
    return next(error);
  }
}

async function updateAdminViralVideo(req, res) {
  try {
    const payload = buildViralVideoPayload(req.body, { partial: true });
    payload.category = 'viral';
    payload.source = 'News Pulse';
    if (!payload.sourceName) payload.sourceName = 'News Pulse';

    if (payload.status === 'published') {
      await assertDailyPublishLimitAvailable(req.params.id);
    }

    if (!isDbReady()) {
      const item = toAdminViralVideoDto(await updateViralVideoInFile(req.params.id, payload));
      if (!item) return res.status(404).json({ ok: false, success: false, message: 'Viral video not found' });
      return res.status(200).json({ ok: true, success: true, item, video: item });
    }

    const query = mongoose.Types.ObjectId.isValid(String(req.params.id)) ? { _id: req.params.id } : { slug: String(req.params.id || '').trim().toLowerCase() };
    if (payload.slug) payload.slug = await buildUniqueViralSlug(payload.slug, payload.slug, req.params.id);
    const doc = await ViralVideo.findOneAndUpdate(query, { $set: payload }, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    const item = toAdminViralVideoDto(doc);
    return res.status(200).json({ ok: true, success: true, item, video: item });
  } catch (error) {
    return res.status(typeof error.status === 'number' ? error.status : 500).json({ ok: false, message: error.message || 'Failed to update viral video' });
  }
}

async function deleteAdminViralVideo(req, res, next) {
  try {
    if (!isDbReady()) {
      const item = toAdminViralVideoDto(await softDeleteViralVideoInFile(req.params.id));
      if (!item) return res.status(404).json({ ok: false, success: false, message: 'Viral video not found' });
      return res.status(200).json({ ok: true, success: true, deleted: true, archived: true, item, video: item });
    }
    const query = mongoose.Types.ObjectId.isValid(String(req.params.id)) ? { _id: req.params.id } : { slug: String(req.params.id || '').trim().toLowerCase() };
    const doc = await ViralVideo.findOneAndUpdate(query, { $set: { isActive: false, isPublished: false, status: 'archived', publishedAt: null } }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ ok: false, message: 'Viral video not found' });
    const item = toAdminViralVideoDto(doc);
    return res.status(200).json({ ok: true, success: true, deleted: true, archived: true, item, video: item });
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
    status: 'unpublished',
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

function selectViralVideoThumbnailFile(files) {
  const uploadedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  for (const fieldName of VIRAL_VIDEO_THUMBNAIL_FIELD_NAMES) {
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

function assertAllowedViralVideoThumbnailFile(file) {
  const mimeType = String(file?.mimetype || '').trim().toLowerCase();
  const extension = path.extname(String(file?.originalname || '')).trim().toLowerCase();

  if (!VIRAL_VIDEO_ACCEPTED_IMAGE_MIME_TYPES.has(mimeType) || !VIRAL_VIDEO_ACCEPTED_IMAGE_EXTENSIONS.has(extension)) {
    const error = new Error(THUMBNAIL_IMAGE_TYPE_NOT_ALLOWED_MESSAGE);
    error.status = 400;
    error.code = 'MEDIA_TYPE_NOT_ALLOWED';
    throw error;
  }

  return { mimeType, extension };
}

function getRequestBaseUrl(req) {
  const envBase = String(process.env.PUBLIC_BASE_URL || process.env.BACKEND_BASE_URL || '').trim().replace(/\/+$/, '');
  if (envBase) return envBase;
  const host = req && typeof req.get === 'function' ? req.get('host') : null;
  if (host) return `${req.protocol || 'http'}://${host}`;
  return `http://localhost:${process.env.PORT || '5052'}`;
}

function buildLocalUploadFilename(file, extension) {
  const basename = path.basename(String(file?.originalname || 'upload')).replace(/\.[^.]*$/, '');
  const safeBase = basename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'viral-video';
  const random = crypto.randomBytes(6).toString('hex');
  return `${Date.now()}-${random}-${safeBase}${extension}`;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function buildViralVideoUploadMetadata(details = {}) {
  const width = normalizePositiveInteger(details.width);
  const height = normalizePositiveInteger(details.height);
  const duration = typeof details.duration === 'number' && Number.isFinite(details.duration) && details.duration > 0
    ? details.duration
    : null;

  if (!width || !height) {
    return {
      metadataAvailable: false,
      warnings: [],
      videoMetadata: null,
    };
  }

  const orientation = height > width ? 'vertical' : (width > height ? 'landscape' : 'square');
  const aspectRatio = `${width}:${height}`;
  const isBestResolution = width === 1080 && height === 1920;
  const isGoodResolution = width === 720 && height === 1280;
  const warnings = [];

  if (orientation === 'landscape') {
    warnings.push(VIRAL_VIDEO_LANDSCAPE_WARNING);
  }

  return {
    metadataAvailable: true,
    warnings,
    videoMetadata: {
      width,
      height,
      duration,
      orientation,
      aspectRatio,
      preferredAspectRatio: '9:16',
      preferredResolution: isBestResolution ? 'best' : (isGoodResolution ? 'good' : null),
      preferredResolutions: {
        best: { width: 1080, height: 1920 },
        good: { width: 720, height: 1280 },
      },
    },
  };
}

async function saveLocalViralVideoUpload(file, { req, kind }) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    const error = new Error('Invalid upload');
    error.status = 400;
    throw error;
  }

  const meta = kind === 'thumbnail' ? assertAllowedViralVideoThumbnailFile(file) : assertAllowedViralVideoFile(file);
  const subfolder = kind === 'thumbnail' ? 'posters' : 'videos';
  const relativeFolder = path.posix.join('uploads', 'viral-videos', subfolder);
  const absoluteFolder = path.join(process.cwd(), 'uploads', 'viral-videos', subfolder);
  await fs.mkdir(absoluteFolder, { recursive: true });

  const filename = buildLocalUploadFilename(file, meta.extension);
  const absolutePath = path.join(absoluteFolder, filename);
  await fs.writeFile(absolutePath, file.buffer, { flag: 'wx' });

  const relativeUrl = `/${relativeFolder}/${encodeURIComponent(filename)}`;
  const absoluteUrl = `${getRequestBaseUrl(req)}${relativeUrl}`;
  return { ...meta, filename, relativeUrl, absoluteUrl };
}

function toStableViralVideoUploadResponse(result, file, capability) {
  const secureUrl = result?.secure_url || result?.url || null;
  if (!secureUrl) {
    const error = new Error(VIDEO_UPLOAD_FAILED_MESSAGE);
    error.code = 'CLOUDINARY_UPLOAD_FAILED';
    throw error;
  }

  const uploadMetadata = buildViralVideoUploadMetadata({
    width: result?.width,
    height: result?.height,
    duration: result?.duration,
  });

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
    metadataAvailable: uploadMetadata.metadataAvailable,
    warnings: uploadMetadata.warnings,
    videoMetadata: uploadMetadata.videoMetadata,
    viralVideosCloudUploadAvailable: true,
    viralVideosCloudUpload: capability,
  };
}

async function uploadViralVideoThumbnailFile(req, res) {
  if (!cloudinaryUploads.isCloudinaryConfigured()) {
    try {
      const file = selectViralVideoThumbnailFile(getUploadedFiles(req));
      if (!file) {
        return res.status(400).json({
          ok: false,
          message: "No file received. Use multipart field 'thumbnail', 'cover', or 'file'.",
        });
      }

      const saved = await saveLocalViralVideoUpload(file, { req, kind: 'thumbnail' });
      const posterImage = { url: saved.absoluteUrl, publicId: null, alt: null };
      return res.status(200).json({
        ok: true,
        success: true,
        provider: 'local',
        message: VIRAL_VIDEO_THUMBNAIL_LOCAL_UPLOAD_MESSAGE,
        url: saved.absoluteUrl,
        secureUrl: saved.absoluteUrl,
        secure_url: saved.absoluteUrl,
        thumbnailUrl: saved.absoluteUrl,
        posterImageUrl: saved.absoluteUrl,
        posterImage,
        thumbnail: posterImage,
        filename: saved.filename,
        data: {
          url: saved.absoluteUrl,
          secureUrl: saved.absoluteUrl,
          secure_url: saved.absoluteUrl,
          publicId: null,
          public_id: null,
          filename: saved.filename,
        },
      });
    } catch (error) {
      return res.status(typeof error?.status === 'number' ? error.status : 500).json({ ok: false, success: false, code: error?.code || undefined, message: error?.message || 'Upload failed' });
    }
  }

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
  if (capability.available !== true || capability.enabled !== true || cloudinaryConfig.configured !== true) {
    logViralVideoCloudinaryUpload('config-missing', {
      ...uploadDiagnostics,
      missing: Array.isArray(cloudinaryConfig.missing) ? cloudinaryConfig.missing : [],
    });
    const saved = await saveLocalViralVideoUpload(file, { req, kind: 'video' });
    return res.status(200).json({
      ok: true,
      success: true,
      code: 'LOCAL_UPLOAD_FALLBACK',
      enabled: capability.enabled === true,
      provider: 'local',
      message: VIRAL_VIDEO_LOCAL_UPLOAD_MESSAGE,
      url: saved.absoluteUrl,
      secure_url: saved.absoluteUrl,
      secureUrl: saved.absoluteUrl,
      resource_type: 'video',
      public_id: null,
      publicId: null,
      videoUrl: saved.absoluteUrl,
      videoFileUrl: saved.absoluteUrl,
      videoStorageProvider: 'local',
      videoPublicId: null,
      videoMimeType: saved.mimeType,
      videoSizeBytes: typeof file?.size === 'number' ? file.size : null,
      metadataAvailable: false,
      warnings: [],
      videoMetadata: null,
      viralVideosCloudUploadAvailable: capability.available === true,
      viralVideosCloudUpload: capability,
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
    const cloudinaryFailureMessage = `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} ${safeCloudinaryError.providerMessage}`.trim();
    logViralVideoCloudinaryUpload('upload-stream-error', {
      ...uploadDiagnostics,
      ...safeCloudinaryError,
      ...(uploadError?.code ? { providerCode: String(uploadError.code).slice(0, 100) } : {}),
    });
    return res.status(400).json({
      ok: false,
      code: 'CLOUDINARY_UPLOAD_FAILED',
      message: cloudinaryFailureMessage,
      providerMessage: safeCloudinaryError.providerMessage,
      error: safeCloudinaryError.providerMessage,
      errorMessage: safeCloudinaryError.providerMessage,
      reason: safeCloudinaryError.providerMessage,
      userMessage: cloudinaryFailureMessage,
      displayMessage: cloudinaryFailureMessage,
      cloudinaryError: safeCloudinaryError.providerMessage,
      providerError: safeCloudinaryError.providerMessage,
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
  getAdminViralVideosDailyCount,
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
