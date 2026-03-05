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

const TRANSLATION_PROVIDER_VALUES = ['google', 'openai', 'manual'];

function normalizeTranslationProvider(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!s) return undefined;
  return s;
}

const translationBucketSchema = new mongoose.Schema(
  {
    title: { type: String, default: null },
    summary: { type: String, default: null },
    content: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    provider: {
      type: String,
      enum: TRANSLATION_PROVIDER_VALUES,
      default: 'google',
      required: false,
      set: normalizeTranslationProvider,
    },
  },
  { _id: false }
);

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

    // Per-language slugs used for language-specific URLs.
    // Keep legacy `slug` for backward compatibility.
    slugs: {
      en: { type: String, default: null, index: true },
      hi: { type: String, default: null, index: true },
      gu: { type: String, default: null, index: true },
    },

    summary: { type: String, default: null },
    content: { type: String, default: null },

    // Cached translations for instant language switching.
    // Strict rule: callers must never fall back to a different language.
    i18n: {
      title: {
        en: { type: String, default: null },
        hi: { type: String, default: null },
        gu: { type: String, default: null },
      },
      summary: {
        en: { type: String, default: null },
        hi: { type: String, default: null },
        gu: { type: String, default: null },
      },
      content: {
        en: { type: String, default: null },
        hi: { type: String, default: null },
        gu: { type: String, default: null },
      },
    },

    category: { type: String, required: true, enum: CATEGORY_VALUES, index: true },
    language: { type: String, enum: LANGUAGE_VALUES, default: 'en', index: true },

    // Immutable-ish: the language the article was originally authored in.
    // Public language switching should translate FROM this language.
    originalLang: { type: String, enum: LANGUAGE_VALUES, default: null, index: true },

    // Cached per-language translations (en/hi/gu).
    // This is the canonical translation cache going forward.
    translations: {
      en: { type: translationBucketSchema, default: () => ({}) },
      hi: { type: translationBucketSchema, default: () => ({}) },
      gu: { type: translationBucketSchema, default: () => ({}) },
    },

    // Background translation status synced from the CMS/admin News document.
    translationStatus: {
      en: { type: String, enum: ['pending', 'ready', 'failed', null], default: null },
      hi: { type: String, enum: ['pending', 'ready', 'failed', null], default: null },
      gu: { type: String, enum: ['pending', 'ready', 'failed', null], default: null },
    },
    translationError: {
      en: { type: String, default: null },
      hi: { type: String, default: null },
      gu: { type: String, default: null },
    },
    translationNextRetryAt: {
      en: { type: Date, default: null },
      hi: { type: Date, default: null },
      gu: { type: Date, default: null },
    },

    status: { type: String, enum: STATUS_VALUES, default: 'draft', index: true },
    publishedAt: { type: Date, default: null, index: true },

    isBreaking: { type: Boolean, default: false, index: true },

    coverImage: {
      url: { type: String, default: null },
      publicId: { type: String, default: null },
      alt: { type: String, default: null },
    },
    tags: { type: [String], default: [] },

    // Auto-tags for National articles (used for state-wise national filtering)
    stateTags: { type: [String], default: [], index: true },
    stateNames: { type: [String], default: [] },

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

    // Backfill originalLang from stored language (never infer from title).
    // If language is missing/invalid, leave originalLang null (public read path may detect from content).
    if ((!this.originalLang || !String(this.originalLang).trim()) && LANGUAGE_VALUES.includes(docLang)) {
      this.originalLang = docLang;
    }

    // Legacy repair: provider=null is not valid for enum provider.
    // Ensure any full translation bucket has provider + generatedAt.
    try {
      const translations = this.translations && typeof this.translations === 'object' ? this.translations : null;
      if (translations) {
        const hasFull = (b) => {
          const bucket = b && typeof b === 'object' ? b : {};
          return Boolean(String(bucket.title || '').trim() && String(bucket.summary || '').trim() && String(bucket.content || '').trim());
        };

        for (const lang of ['en', 'hi', 'gu']) {
          const b = translations[lang];
          if (!b || typeof b !== 'object') continue;
          if (b.provider === null) b.provider = 'google';
          if (hasFull(b) && !b.generatedAt) b.generatedAt = new Date();
        }
      }
    } catch (_) {}

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
articleSchema.index({ category: 1, status: 1, stateTags: 1, publishedAt: -1 });
articleSchema.index({ slug: 1 }, { unique: true });
articleSchema.index({ 'slugs.en': 1 });
articleSchema.index({ 'slugs.hi': 1 });
articleSchema.index({ 'slugs.gu': 1 });

module.exports = mongoose.models.Article || mongoose.model('Article', articleSchema);
module.exports.CATEGORY_VALUES = CATEGORY_VALUES;
module.exports.LANGUAGE_VALUES = LANGUAGE_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;
