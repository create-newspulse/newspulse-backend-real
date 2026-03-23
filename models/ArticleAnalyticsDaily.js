const mongoose = require('mongoose');

const breakdownEntrySchema = new mongoose.Schema(
  {
    source: { type: String, default: null },
    language: { type: String, default: null },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const articleAnalyticsDailySchema = new mongoose.Schema(
  {
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    slug: { type: String, default: null, index: true },
    dateKey: { type: String, required: true, index: true }, // YYYY-MM-DD
    category: { type: String, default: null, index: true },
    language: { type: String, default: null, index: true },

    views: { type: Number, default: 0 },
    uniqueReaders: { type: Number, default: 0 },
    engagedReads: { type: Number, default: 0 },

    totalReadTimeSec: { type: Number, default: 0 },
    avgReadTimeSec: { type: Number, default: 0 },

    scroll25Count: { type: Number, default: 0 },
    scroll50Count: { type: Number, default: 0 },
    scroll75Count: { type: Number, default: 0 },
    scroll100Count: { type: Number, default: 0 },

    completionRate: { type: Number, default: 0 },

    sourceBreakdown: { type: [breakdownEntrySchema], default: [] },
    languageBreakdown: { type: [breakdownEntrySchema], default: [] },

    updatedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
  }
);

articleAnalyticsDailySchema.index({ articleId: 1, dateKey: 1 }, { unique: true });
articleAnalyticsDailySchema.index({ dateKey: 1, views: -1 });

module.exports = mongoose.model('ArticleAnalyticsDaily', articleAnalyticsDailySchema);
