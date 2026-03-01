const mongoose = require('mongoose');

const { getIstDateKey, formatIstTimeText } = require('../src/utils/istDate');

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

    // Simplified i18n storage (Phase 1/2 simplification): one document contains all langs.
    // When a translation is missing or rejected by heuristics, the field may be null/empty.
    text_i18n: {
      en: { type: String, required: false, maxlength: 160, trim: true, default: null },
      hi: { type: String, required: false, maxlength: 160, trim: true, default: null },
      gu: { type: String, required: false, maxlength: 160, trim: true, default: null },
    },

    // Per-story translation cache (preferred contract): translations.{en|hi|gu}
    // Kept in sync with text_i18n for backward compatibility.
    translations: {
      en: { type: String, required: false, maxlength: 160, trim: true, default: null },
      hi: { type: String, required: false, maxlength: 160, trim: true, default: null },
      gu: { type: String, required: false, maxlength: 160, trim: true, default: null },
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

    // Daily IST cycle support (YYYY-MM-DD in Asia/Kolkata).
    // New code uses this for 24/7 tickers; older code can ignore.
    dateKey: {
      type: String,
      required: false,
      index: true,
    },

    // Optional display time text (IST), e.g. "10:35 AM".
    timeText: {
      type: String,
      required: false,
      trim: true,
      maxlength: 16,
      default: null,
    },

    // Optional link target for the ticker item.
    linkUrl: {
      type: String,
      required: false,
      trim: true,
      maxlength: 2048,
      default: null,
    },

    // Ordering controls (higher shows first).
    priority: {
      type: Number,
      required: false,
      default: 0,
      index: true,
    },
    isPinned: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Soft disable without deleting.
    isActive: {
      type: Boolean,
      // Leave unset for backward compatibility (older docs/clients only used isLive).
      // Queries should treat missing isActive as active.
      default: undefined,
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
    // Ensure daily dateKey/timeText for new ticker APIs.
    if (!this.createdAt) this.createdAt = new Date();
    if (!this.dateKey) {
      const dk = getIstDateKey(this.createdAt);
      if (dk) this.dateKey = dk;
    }
    if (!this.timeText) {
      const tt = formatIstTimeText(this.createdAt);
      if (tt) this.timeText = tt;
    }

    // Keep legacy isLive aligned with isActive if callers only set one.
    if (typeof this.isActive === 'boolean' && (this.isLive === undefined || this.isLive === null)) {
      this.isLive = this.isActive;
    }
    if (typeof this.isLive === 'boolean' && (this.isActive === undefined || this.isActive === null)) {
      this.isActive = this.isLive;
    }

    const sourceLang = SUPPORTED_LANGS.includes(String(this.sourceLang || '')) ? String(this.sourceLang) : 'gu';
    this.sourceLang = sourceLang;

    const rawText = typeof this.text === 'string' ? this.text.trim() : '';

    if (!this.text_i18n || typeof this.text_i18n !== 'object') this.text_i18n = {};
    if (!this.translations || typeof this.translations !== 'object') this.translations = {};

    // Ensure objects exist.
    if (!this.textByLang || typeof this.textByLang !== 'object') this.textByLang = {};
    if (!this.statusByLang || typeof this.statusByLang !== 'object') this.statusByLang = {};
    if (!this.qualityByLang || typeof this.qualityByLang !== 'object') this.qualityByLang = {};

    // Always persist the source language text.
    if (rawText) {
      if (!this.text_i18n[sourceLang]) {
        this.text_i18n[sourceLang] = rawText;
      }
      if (!this.translations[sourceLang]) {
        this.translations[sourceLang] = rawText;
      }
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

    // If text_i18n is missing but textByLang exists, backfill it.
    for (const l of SUPPORTED_LANGS) {
      if (!this.text_i18n[l] && typeof this.textByLang[l] === 'string' && this.textByLang[l].trim()) {
        this.text_i18n[l] = this.textByLang[l];
      }
    }

    // Keep translations aligned with text_i18n.
    for (const l of SUPPORTED_LANGS) {
      if (!this.translations[l] && typeof this.text_i18n[l] === 'string' && this.text_i18n[l].trim()) {
        this.translations[l] = this.text_i18n[l];
      }
      if (!this.text_i18n[l] && typeof this.translations[l] === 'string' && this.translations[l].trim()) {
        this.text_i18n[l] = this.translations[l];
      }
    }

    // Keep textByLang aligned for any code paths still reading it.
    for (const l of SUPPORTED_LANGS) {
      if (!this.textByLang[l] && typeof this.text_i18n[l] === 'string' && this.text_i18n[l].trim()) {
        this.textByLang[l] = this.text_i18n[l];
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

// Daily ticker query index (IST dateKey + ordering).
BroadcastItemSchema.index(
  { type: 1, dateKey: 1, isActive: 1, isPinned: -1, priority: -1, createdAt: -1 },
  { name: 'ticker_day_order' },
);

module.exports = mongoose.models.BroadcastItem || mongoose.model('BroadcastItem', BroadcastItemSchema);
