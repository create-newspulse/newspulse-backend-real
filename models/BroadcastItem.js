const mongoose = require('mongoose');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

const BroadcastItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['breaking', 'live'],
      index: true,
      // New API calls this field "channel"; keep DB field as "type" for backward compatibility.
      alias: 'channel',
    },
    text: {
      type: String,
      required: true,
      maxlength: 160,
      trim: true,
    },
    // Legacy field (kept for backward compatibility with existing deployments/UI).
    language: {
      type: String,
      enum: SUPPORTED_LANGS,
      default: 'en',
      index: true,
    },

    // Phase 1: language-aware broadcast items
    sourceLang: {
      type: String,
      enum: SUPPORTED_LANGS,
      default: 'gu',
      index: true,
    },
    textByLang: {
      en: { type: String, required: false, maxlength: 160, trim: true },
      hi: { type: String, required: false, maxlength: 160, trim: true },
      gu: { type: String, required: false, maxlength: 160, trim: true },
    },
    statusByLang: {
      en: { type: String, enum: ['APPROVED', 'BLOCKED', 'PROCESSING'], required: false },
      hi: { type: String, enum: ['APPROVED', 'BLOCKED', 'PROCESSING'], required: false },
      gu: { type: String, enum: ['APPROVED', 'BLOCKED', 'PROCESSING'], required: false },
    },
    qualityByLang: {
      en: { type: Number, required: false, min: 0, max: 100 },
      hi: { type: Number, required: false, min: 0, max: 100 },
      gu: { type: Number, required: false, min: 0, max: 100 },
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isLive: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      required: false,
    },
  },
  { timestamps: true },
);

BroadcastItemSchema.pre('validate', function ensureLangFields(next) {
  try {
    const sourceLang = SUPPORTED_LANGS.includes(String(this.sourceLang || '')) ? String(this.sourceLang) : 'gu';
    this.sourceLang = sourceLang;

    const rawText = typeof this.text === 'string' ? this.text.trim() : '';

    // Ensure objects exist.
    if (!this.textByLang || typeof this.textByLang !== 'object') this.textByLang = {};
    if (!this.statusByLang || typeof this.statusByLang !== 'object') this.statusByLang = {};
    if (!this.qualityByLang || typeof this.qualityByLang !== 'object') this.qualityByLang = {};

    // Always persist the source language text.
    if (rawText) {
      if (!this.textByLang[sourceLang]) {
        this.textByLang[sourceLang] = rawText;
      }
    }

    // If textByLang is missing but legacy text exists, backfill.
    if (rawText) {
      const hasAny = SUPPORTED_LANGS.some(l => typeof this.textByLang[l] === 'string' && this.textByLang[l].trim());
      if (!hasAny) {
        this.textByLang[sourceLang] = rawText;
      }
    }

    // Default the source language status/quality.
    if (!this.statusByLang[sourceLang]) this.statusByLang[sourceLang] = 'APPROVED';
    if (typeof this.qualityByLang[sourceLang] !== 'number') this.qualityByLang[sourceLang] = 100;

    return next();
  } catch (e) {
    return next(e);
  }
});

// Auto-delete after expiresAt.
BroadcastItemSchema.index({ expiresAt: 1 }, { name: 'expiresAt_ttl', expireAfterSeconds: 0 });

module.exports = mongoose.models.BroadcastItem || mongoose.model('BroadcastItem', BroadcastItemSchema);
