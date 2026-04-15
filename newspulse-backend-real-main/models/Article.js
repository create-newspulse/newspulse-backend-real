const mongoose = require('mongoose');
const { canonicalizeSlug } = require('../../lib/slug');

const CATEGORY_VALUES = [
  'breaking',
  'regional',
  'national',
  'international',
  'business',
  'tech',
  'sports',
  'lifestyle',
  'glamour',
  'web-stories',
  'editorial',
  'youth-pulse',
  'inspiration-hub',
];

const LANGUAGE_VALUES = ['en', 'hi', 'gu'];
const STATUS_VALUES = ['draft', 'published'];

function _normalizeCoverImage(ret) {
  if (!ret) return ret;
  const v = ret.coverImage;
  if (typeof v === 'string') {
    ret.coverImage = { url: v, publicId: null, alt: null };
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    ret.coverImage = {
      url: v.url ? String(v.url) : null,
      publicId: v.publicId ? String(v.publicId) : null,
      alt: v.alt ? String(v.alt) : null,
    };
  } else if (v === undefined) {
    // leave as-is
  } else {
    ret.coverImage = null;
  }
  return ret;
}

const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },

    summary: { type: String, default: null },
    content: { type: String, default: null },

    category: { type: String, required: true, enum: CATEGORY_VALUES, index: true },
    language: { type: String, enum: LANGUAGE_VALUES, default: 'en', index: true },

    status: { type: String, enum: STATUS_VALUES, default: 'draft', index: true },
    publishedAt: { type: Date, default: null, index: true },

    isBreaking: { type: Boolean, default: false, index: true },

    coverImage: {
      url: { type: String, default: null },
      publicId: { type: String, default: null },
      alt: { type: String, default: null },
    },
    tags: { type: [String], default: [] },

    state: { type: String, default: null },
    district: { type: String, default: null },
    city: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => _normalizeCoverImage(ret),
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret) => _normalizeCoverImage(ret),
    },
  }
);

// Store slugs as plain Unicode (not percent-encoded) so lookups are stable across clients.
articleSchema.pre('validate', function preValidate(next) {
  try {
    if (this.isModified('slug')) {
      this.slug = canonicalizeSlug(this.slug);
    }

    // Backward compatibility: older docs/clients used `coverImage` as a string URL.
    try {
      if (this.coverImage && typeof this.coverImage === 'string') {
        this.coverImage = { url: String(this.coverImage), publicId: null, alt: null };
      }
    } catch (_) {}
    return next();
  } catch (e) {
    return next(e);
  }
});

articleSchema.pre('save', function preSave(next) {
  try {
    if (this.isModified('status')) {
      const nextStatus = String(this.status || 'draft').toLowerCase();
      if (nextStatus === 'published' && !this.publishedAt) {
        this.publishedAt = new Date();
      }
      if (nextStatus !== 'published') {
        this.publishedAt = null;
      }
    }
    return next();
  } catch (e) {
    return next(e);
  }
});

// Required indexes
articleSchema.index({ status: 1, category: 1, publishedAt: -1 });
articleSchema.index({ status: 1, isBreaking: 1, publishedAt: -1 });
articleSchema.index({ slug: 1 }, { unique: true });

module.exports = mongoose.models.Article || mongoose.model('Article', articleSchema);
module.exports.CATEGORY_VALUES = CATEGORY_VALUES;
module.exports.LANGUAGE_VALUES = LANGUAGE_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;
