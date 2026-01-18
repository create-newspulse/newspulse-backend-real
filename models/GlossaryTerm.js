const mongoose = require('mongoose');

function _normalizeKey(v) {
  return String(v || '').trim();
}

function _normalizeKeyNorm(v) {
  return _normalizeKey(v).toLowerCase();
}

const GlossaryTermSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    // Case-insensitive uniqueness is enforced via this normalized field.
    keyNorm: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
      index: true,
      unique: true,
    },
    en: { type: String, required: true, trim: true, default: '' },
    hi: { type: String, required: true, trim: true, default: '' },
    gu: { type: String, required: true, trim: true, default: '' },
    doNotTranslate: { type: Boolean, default: false },
  },
  { timestamps: true },
);

GlossaryTermSchema.pre('validate', function ensureNorm(next) {
  try {
    const key = _normalizeKey(this.key);
    this.key = key;
    this.keyNorm = _normalizeKeyNorm(key);
    return next();
  } catch (e) {
    return next(e);
  }
});

GlossaryTermSchema.index({ keyNorm: 1 }, { unique: true, name: 'keyNorm_unique' });

module.exports = mongoose.models.GlossaryTerm || mongoose.model('GlossaryTerm', GlossaryTermSchema);
