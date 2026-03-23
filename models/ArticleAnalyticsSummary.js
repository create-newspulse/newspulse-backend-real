const mongoose = require('mongoose');

const breakdownEntrySchema = new mongoose.Schema(
  {
    source: { type: String, default: null },
    language: { type: String, default: null },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const articleAnalyticsSummarySchema = new mongoose.Schema(
  {
    articleId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, index: true },
    slug: { type: String, default: null, index: true },
    category: { type: String, default: null, index: true },
    language: { type: String, default: null, index: true },

    totalViews: { type: Number, default: 0 },
    totalUniqueReaders: { type: Number, default: 0 },
    totalEngagedReads: { type: Number, default: 0 },

    totalReadTimeSec: { type: Number, default: 0 },
    avgReadTimeSec: { type: Number, default: 0 },

    scroll25Count: { type: Number, default: 0 },
    scroll50Count: { type: Number, default: 0 },
    scroll75Count: { type: Number, default: 0 },
    scroll100Count: { type: Number, default: 0 },

    completionRate: { type: Number, default: 0 },

    sourceBreakdown: { type: [breakdownEntrySchema], default: [] },
    topSources: { type: [breakdownEntrySchema], default: [] },
    languageBreakdown: { type: [breakdownEntrySchema], default: [] },

    last24hViews: { type: Number, default: 0 },
    last7dViews: { type: Number, default: 0 },

    updatedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
  }
);

articleAnalyticsSummarySchema.index({ category: 1, totalViews: -1 });
articleAnalyticsSummarySchema.index({ updatedAt: -1 });

module.exports = mongoose.model('ArticleAnalyticsSummary', articleAnalyticsSummarySchema);
