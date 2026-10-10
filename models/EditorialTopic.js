const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');

const LIMITS = Object.freeze({ slug: 140, name: 160, description: 1000, tags: 20, tag: 120 });
const LANGUAGES = ['gu', 'hi', 'en'];

function isCanonicalTopicSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.slug
    && value === slugifyUnicode(value, { maxLength: LIMITS.slug })
    && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:-[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u.test(value);
}

function isExactTopicTag(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= LIMITS.tag && !/[\u0000-\u001f\u007f*]/.test(value);
}

const schema = new mongoose.Schema({
  slug: { type: String, required: true, trim: true, lowercase: true, immutable: true, validate: isCanonicalTopicSlug },
  name: Object.fromEntries(LANGUAGES.map(lang => [lang, { type: String, required: true, trim: true, maxlength: LIMITS.name }])),
  description: Object.fromEntries(LANGUAGES.map(lang => [lang, { type: String, trim: true, default: '', maxlength: LIMITS.description }])),
  active: { type: Boolean, default: false },
  order: { type: Number, default: 0, validate: Number.isSafeInteger },
  startsAt: { type: Date, required: true },
  expiresAt: {
    type: Date,
    default: null,
    validate: {
      validator(value) { return value == null || (this.startsAt instanceof Date && value > this.startsAt); },
      message: 'expiresAt must be later than startsAt',
    },
  },
  articleTags: {
    type: [String],
    required: true,
    default: undefined,
    castNonArrays: false,
    set: values => Array.isArray(values)
      ? [...new Set(values.map(value => typeof value === 'string' ? value.trim() : value))]
      : values,
    validate: values => Array.isArray(values) && values.length > 0 && values.length <= LIMITS.tags
      && values.every(isExactTopicTag),
  },
  pinnedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null },
  createdBy: { type: String, default: null, immutable: true },
  updatedBy: { type: String, default: null },
}, { timestamps: true, optimisticConcurrency: true });

schema.index({ slug: 1 }, { unique: true });
schema.index({ active: 1, order: 1, _id: 1 });

module.exports = mongoose.models.EditorialTopic || mongoose.model('EditorialTopic', schema);
module.exports.LIMITS = LIMITS;
module.exports.isCanonicalTopicSlug = isCanonicalTopicSlug;
module.exports.isExactTopicTag = isExactTopicTag;
