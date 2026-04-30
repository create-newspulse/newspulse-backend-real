const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');

const LANGUAGE_VALUES = ['en', 'hi', 'gu'];
const SOURCE_TYPE_VALUES = ['url', 'upload'];

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
    thumbnailUrl: { type: String, default: null, trim: true },
    posterImage: { type: imageSchema, default: () => ({}), alias: 'thumbnail' },
    videoUrl: { type: String, default: null, trim: true },
    embedUrl: { type: String, default: null, trim: true },
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
    isPublished: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
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

viralVideoSchema.index({ isPublished: 1, publishedAt: -1, sortOrder: -1, createdAt: -1 });
viralVideoSchema.index({ isPublished: 1, isHomepageVisible: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ isFeatured: 1, isPublished: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ isFeatured: 1, isPublished: 1, isHomepageVisible: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ status: 1, homepageFeatured: 1, publishedAt: -1, sortOrder: -1 });
viralVideoSchema.index({ language: 1, isPublished: 1, publishedAt: -1 });
viralVideoSchema.index({ tags: 1, isPublished: 1, publishedAt: -1 });
viralVideoSchema.index({ category: 1, isPublished: 1, publishedAt: -1 });

module.exports = mongoose.models.ViralVideo || mongoose.model('ViralVideo', viralVideoSchema);
module.exports.LANGUAGE_VALUES = LANGUAGE_VALUES;
module.exports.SOURCE_TYPE_VALUES = SOURCE_TYPE_VALUES;
module.exports.normalizeSourceType = normalizeSourceType;
