const mongoose = require('mongoose');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

const TranslationMemorySchema = new mongoose.Schema(
  {
    sourceHash: { type: String, required: true, trim: true, maxlength: 64 },
    sourceLang: { type: String, required: true, enum: SUPPORTED_LANGS, index: true },
    targetLang: { type: String, required: true, enum: SUPPORTED_LANGS, index: true },

    translatedText: { type: String, required: true, trim: true, maxlength: 2000 },
    qualityScore: { type: Number, required: true, min: 0, max: 100, default: 0 },
    approved: { type: Boolean, default: false, index: true },

    glossaryVersion: { type: String, required: false, trim: true, maxlength: 64 },
    engineUsed: { type: String, required: false, trim: true, maxlength: 40 },
  },
  { timestamps: true },
);

TranslationMemorySchema.index(
  { sourceHash: 1, sourceLang: 1, targetLang: 1 },
  { unique: true, name: 'tm_unique_source_lang_target' },
);

module.exports = mongoose.models.TranslationMemory || mongoose.model('TranslationMemory', TranslationMemorySchema);
