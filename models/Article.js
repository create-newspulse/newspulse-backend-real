const mongoose = require('mongoose');
const { canonicalizeSlug } = require('../lib/slug');

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
  'viral-videos',
  'editorial',
  'youth-pulse',
  'inspiration-hub',
];

const LANGUAGE_VALUES = ['en', 'hi', 'gu'];
const STATUS_VALUES = ['draft', 'published'];

const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },

    // Per-language slugs used for language-specific URLs.
    // Keep legacy `slug` for backward compatibility.
    slugs: {
      en: { type: String, default: null, index: true },
      hi: { type: String, default: null, index: true },
      gu: { type: String, default: null, index: true },
    },

    summary: { type: String, default: null },
    content: { type: String, default: null },

    category: { type: String, required: true, enum: CATEGORY_VALUES, index: true },
    language: { type: String, enum: LANGUAGE_VALUES, default: 'en', index: true },

    status: { type: String, enum: STATUS_VALUES, default: 'draft', index: true },
    publishedAt: { type: Date, default: null, index: true },

    isBreaking: { type: Boolean, default: false, index: true },

    coverImage: { type: String, default: null },
    tags: { type: [String], default: [] },

    state: { type: String, default: null },
    district: { type: String, default: null },
    city: { type: String, default: null },
  },
  { timestamps: true }
);

// Store slugs as plain Unicode (not percent-encoded) so lookups are stable across clients.
articleSchema.pre('validate', function preValidate(next) {
  try {
    if (this.isModified('slug')) {
      this.slug = canonicalizeSlug(this.slug);
    }

    if (this.slugs && typeof this.slugs === 'object') {
      for (const k of ['en', 'hi', 'gu']) {
        if (this.slugs[k] !== undefined && this.slugs[k] !== null) {
          this.slugs[k] = canonicalizeSlug(this.slugs[k]);
        }
      }
    }

    const docLang = String(this.language || 'en').trim().toLowerCase();
    if ((!this.slug || !String(this.slug).trim()) && this.slugs && this.slugs[docLang]) {
      this.slug = this.slugs[docLang];
    }

    return next();
  } catch (e) {
    return next(e);
  }
});

// When status becomes published, ensure publishedAt is set.
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
articleSchema.index({ 'slugs.en': 1 });
articleSchema.index({ 'slugs.hi': 1 });
articleSchema.index({ 'slugs.gu': 1 });

module.exports = mongoose.models.Article || mongoose.model('Article', articleSchema);
module.exports.CATEGORY_VALUES = CATEGORY_VALUES;
module.exports.LANGUAGE_VALUES = LANGUAGE_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;
