const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');

const LANGUAGE_VALUES = ['en', 'hi', 'gu'];
const SOURCE_TYPE_VALUES = ['url', 'upload'];
const VIDEO_TYPE_VALUES = ['uploaded', 'youtube', 'x', 'external'];
const PLAYBACK_MODE_VALUES = ['internal', 'embed', 'x_embed', 'external'];

function normalizeSourceType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'url';
  if (raw === 'uploaded' || raw === 'file' || raw === 'cloud') return 'upload';
  if (raw === 'embed' || raw === 'external' || raw === 'reel' || raw === 'reels' || raw === 'short_clip' || raw === 'short clip' || raw === 'short-clip') return 'url';
  return SOURCE_TYPE_VALUES.includes(raw) ? raw : 'url';
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];

  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
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

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, default: null, trim: true },
    publicId: { type: String, default: null, trim: true },
    alt: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const viralVideoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    summary: { type: String, default: null, trim: true, alias: 'shortCaption' },
    sourceName: { type: String, default: null, trim: true },
    sourceUrl: { type: String, default: null, trim: true },
    thumbnailUrl: { type: String, default: null, trim: true },
    posterImageUrl: { type: String, default: null, trim: true },
    posterImage: { type: imageSchema, default: () => ({}), alias: 'thumbnail' },
    videoUrl: { type: String, default: null, trim: true },
    videoFileUrl: { type: String, default: null, trim: true },
    embedUrl: { type: String, default: null, trim: true },
    videoType: { type: String, enum: VIDEO_TYPE_VALUES, default: 'external', index: true },
    playbackMode: { type: String, enum: PLAYBACK_MODE_VALUES, default: 'external', index: true },
    sourceType: {
      type: String,
      enum: SOURCE_TYPE_VALUES,
      default: 'url',
      index: true,
      set: normalizeSourceType,
    },
    videoStorageProvider: { type: String, default: null, trim: true },
    videoPublicId: { type: String, default: null, trim: true },
    videoKey: { type: String, default: null, trim: true },
    videoMimeType: { type: String, default: null, trim: true },
    videoSizeBytes: { type: Number, default: null },
    videoDuration: { type: Number, default: null },
    language: { type: String, enum: LANGUAGE_VALUES, default: 'en', index: true },
    category: { type: String, default: null, trim: true, index: true },
    tags: {
      type: [String],
      default: [],
      set: normalizeStringArray,
    },
    isActive: { type: Boolean, default: true, index: true },
    isPublished: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    globalFrontend: { type: Boolean, default: true, index: true },
    isHomepageVisible: { type: Boolean, default: true, index: true, alias: 'showOnHomepage' },
    homepageFeatured: { type: Boolean, default: false, index: true },
    isFeatured: { type: Boolean, default: false, index: true, alias: 'isFeaturedHomepage' },
    publishedAt: { type: Date, default: null, index: true },
    sortOrder: { type: Number, default: 0, index: true, alias: 'priority' },
  },
  { timestamps: true }
);

viralVideoSchema.pre('validate', function ensureCanonicalFields(next) {
  if (!this.slug && this.title) {
    this.slug = slugifyUnicode(this.title);
  }

  this.slug = String(this.slug || '').trim().toLowerCase();

  if (!this.posterImage || typeof this.posterImage !== 'object') {
    this.posterImage = { url: null, publicId: null, alt: null };
  }

  if (this.thumbnailUrl && !this.posterImage.url) {
    this.posterImage.url = this.thumbnailUrl;
  }

  if (this.posterImage.url && !this.thumbnailUrl) {
    this.thumbnailUrl = this.posterImage.url;
  }

  if (this.posterImageUrl && !this.posterImage.url) {
    this.posterImage.url = this.posterImageUrl;
  }

  if (this.posterImage.url && !this.posterImageUrl) {
    this.posterImageUrl = this.posterImage.url;
  }

  if (this.thumbnailUrl && !this.posterImageUrl) {
    this.posterImageUrl = this.thumbnailUrl;
  }

  if (this.posterImageUrl && !this.thumbnailUrl) {
    this.thumbnailUrl = this.posterImageUrl;
  }

  if (this.videoFileUrl && !this.videoUrl) {
    this.videoUrl = this.videoFileUrl;
  }

  const videoCandidate = this.videoFileUrl || this.videoUrl || this.embedUrl || this.sourceUrl;
  if (this.videoFileUrl || this.sourceType === 'upload' || this.videoType === 'uploaded' || isUploadedVideoUrl(videoCandidate)) {
    const fileUrl = this.videoFileUrl || this.videoUrl || videoCandidate;
    this.videoFileUrl = fileUrl || null;
    this.videoUrl = fileUrl || this.videoUrl || null;
    this.videoType = 'uploaded';
    this.playbackMode = 'internal';
    this.sourceType = 'upload';
  } else if (this.videoType === 'youtube' || this.playbackMode === 'embed' || isYouTubeUrl(videoCandidate)) {
    this.videoType = 'youtube';
    this.playbackMode = 'embed';
    this.sourceType = 'url';
    if (!this.embedUrl) this.embedUrl = videoCandidate;
    if (!this.videoUrl) this.videoUrl = videoCandidate;
    if (!this.sourceUrl && this.videoUrl) this.sourceUrl = this.videoUrl;
  } else if (this.videoType === 'x' || this.playbackMode === 'x_embed' || isXStatusUrl(videoCandidate)) {
    const xUrl = this.videoUrl || this.sourceUrl || this.embedUrl || videoCandidate;
    this.videoType = 'x';
    this.playbackMode = 'x_embed';
    this.sourceType = 'url';
    this.videoUrl = xUrl || this.videoUrl || null;
    this.sourceUrl = xUrl || this.sourceUrl || null;
    this.sourceName = 'X';
  } else {
    this.videoType = 'external';
    this.playbackMode = 'external';
    this.sourceType = 'url';
    if (!this.sourceUrl && videoCandidate) this.sourceUrl = videoCandidate;
  }

  if (this.status === 'published') {
    this.isPublished = true;
  }

  if (this.isPublished) {
    this.status = 'published';
  } else if (this.status !== 'published') {
    this.status = 'draft';
  }

  if (this.isPublished && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  if (this.homepageFeatured === true || this.isFeaturedHomepage === true) {
    this.isFeatured = true;
  }

  if (this.isFeatured === true) {
    this.homepageFeatured = true;
  }

  if (!this.videoUrl) {
    this.invalidate('videoUrl', 'videoUrl is required');
  }

  next();
});

viralVideoSchema.index({ isActive: 1, isPublished: 1, publishedAt: -1, sortOrder: -1, createdAt: -1 });
viralVideoSchema.index({ isActive: 1, isPublished: 1, globalFrontend: 1, publishedAt: -1, sortOrder: -1, createdAt: -1 });
viralVideoSchema.index({ isActive: 1, isPublished: 1, isHomepageVisible: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ isActive: 1, isFeatured: 1, isPublished: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ isActive: 1, isFeatured: 1, isPublished: 1, isHomepageVisible: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ status: 1, homepageFeatured: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ language: 1, isActive: 1, isPublished: 1, publishedAt: -1 });
viralVideoSchema.index({ tags: 1, isActive: 1, isPublished: 1, publishedAt: -1 });
viralVideoSchema.index({ category: 1, isActive: 1, isPublished: 1, publishedAt: -1 });

module.exports = mongoose.models.ViralVideo || mongoose.model('ViralVideo', viralVideoSchema);
module.exports.LANGUAGE_VALUES = LANGUAGE_VALUES;
module.exports.SOURCE_TYPE_VALUES = SOURCE_TYPE_VALUES;
module.exports.VIDEO_TYPE_VALUES = VIDEO_TYPE_VALUES;
module.exports.PLAYBACK_MODE_VALUES = PLAYBACK_MODE_VALUES;
module.exports.normalizeSourceType = normalizeSourceType;
