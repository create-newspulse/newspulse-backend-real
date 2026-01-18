const mongoose = require('mongoose');

const TranslationCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, index: true, unique: true },
    sourceText: { type: String, required: true },
    sourceLang: { type: String, required: true, enum: ['en', 'hi', 'gu'], index: true },
    targetLang: { type: String, required: true, enum: ['en', 'hi', 'gu'], index: true },
    translatedText: { type: String, required: true },
    score: { type: Number, required: true, default: 0 },
    warnings: { type: [String], default: [] },
    provider: { type: String, required: true, enum: ['GOOGLE'], default: 'GOOGLE' },
    hits: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: true,
  }
);

TranslationCacheSchema.index({ sourceLang: 1, targetLang: 1, updatedAt: -1 });

module.exports = mongoose.model('TranslationCache', TranslationCacheSchema);
