const mongoose = require('mongoose');

const {
  TICKER_AD_LANGS,
  TICKER_AD_CHANNELS,
  TICKER_AD_DAY_PARTS,
  sanitizeTickerAdMessage,
  normalizeOptionalTickerAdUrl,
  isValidTickerAdHttpUrl,
  normalizeTickerAdDayParts,
  clampTickerAdFrequency,
} = require('../lib/tickerAds');

const TickerAdSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
      maxlength: 140,
      trim: true,
      set: sanitizeTickerAdMessage,
    },
    url: {
      type: String,
      required: false,
      default: null,
      maxlength: 300,
      trim: true,
      set: normalizeOptionalTickerAdUrl,
      validate: {
        validator: (value) => isValidTickerAdHttpUrl(value),
        message: 'url must start with http:// or https://',
      },
    },
    lang: {
      type: String,
      required: true,
      enum: TICKER_AD_LANGS,
      index: true,
    },
    channel: {
      type: String,
      required: true,
      enum: TICKER_AD_CHANNELS,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    startAt: {
      type: Date,
      required: true,
      index: true,
    },
    endAt: {
      type: Date,
      required: true,
      index: true,
    },
    dayParts: {
      type: [{ type: String, enum: TICKER_AD_DAY_PARTS }],
      default: () => TICKER_AD_DAY_PARTS.slice(),
      index: true,
    },
    priority: {
      type: Number,
      default: 0,
      index: true,
    },
    frequency: {
      type: Number,
      default: 3,
      min: 1,
      max: 10,
      set: (value) => clampTickerAdFrequency(value, 3),
    },
    createdBy: {
      type: String,
      required: false,
      default: null,
      trim: true,
      maxlength: 120,
    },
    updatedBy: {
      type: String,
      required: false,
      default: null,
      trim: true,
      maxlength: 120,
    },
  },
  {
    timestamps: true,
  }
);

TickerAdSchema.pre('validate', function ensureTickerAdFields(next) {
  try {
    this.message = sanitizeTickerAdMessage(this.message);
    this.url = normalizeOptionalTickerAdUrl(this.url);
    this.frequency = clampTickerAdFrequency(this.frequency, 3);

    const normalizedDayParts = normalizeTickerAdDayParts(this.dayParts);
    if (!normalizedDayParts) {
      this.invalidate('dayParts', 'dayParts must contain morning|noon|evening|night');
    } else {
      this.dayParts = normalizedDayParts;
    }

    if (!this.message) {
      this.invalidate('message', 'message is required');
    }

    if (this.startAt instanceof Date && this.endAt instanceof Date) {
      if (this.endAt.getTime() <= this.startAt.getTime()) {
        this.invalidate('endAt', 'endAt must be greater than startAt');
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

TickerAdSchema.index({ lang: 1, channel: 1, isActive: 1, startAt: 1, endAt: 1, priority: -1 });

TickerAdSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.models.TickerAd || mongoose.model('TickerAd', TickerAdSchema);