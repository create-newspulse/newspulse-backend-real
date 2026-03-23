const mongoose = require('mongoose');

const KINDS = [
  'view_cooldown',
  'unique_reader_day',
  'engaged_session',
  'scroll_milestone',
  'heartbeat_cooldown',
];

const articleAnalyticsDedupSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },

    articleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    visitorId: { type: String, required: true, default: '', index: true },
    // Use a non-empty sentinel when a dimension does not apply.
    sessionId: { type: String, required: true, default: '0', index: true },

    dateKey: { type: String, required: true, default: '0', index: true }, // YYYY-MM-DD or '0'
    milestone: { type: Number, required: true, default: -1, index: true },

    lastAt: { type: Date, default: null, index: true },
    expiresAt: { type: Date, default: null, index: true },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// TTL cleanup for dedupe keys
articleAnalyticsDedupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Single key per (kind + dimensions)
articleAnalyticsDedupSchema.index(
  { kind: 1, articleId: 1, visitorId: 1, sessionId: 1, dateKey: 1, milestone: 1 },
  { unique: true }
);

module.exports = mongoose.model('ArticleAnalyticsDedup', articleAnalyticsDedupSchema);
module.exports.KINDS = KINDS;
