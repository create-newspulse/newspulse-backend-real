const mongoose = require('mongoose');

const STATUSES = ['QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'DONE', 'BLOCKED', 'COMPLETED', 'FAILED'];
const REVIEW_STATUSES = ['NONE', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'];

const TranslationJobSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ['BROADCAST_ITEM'],
      index: true,
    },
    refId: {
      // e.g., BroadcastItem _id
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // New single-language fields (preferred)
    langFrom: { type: String, enum: ['en', 'hi', 'gu'], required: false, index: true },
    langTo: { type: String, enum: ['en', 'hi', 'gu'], required: false, index: true },

    // Backward compatibility (older multi-target jobs)
    sourceLang: { type: String, enum: ['en', 'hi', 'gu'], required: false },
    targetLangs: { type: [String], default: [], required: false },

    status: { type: String, enum: STATUSES, default: 'QUEUED', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: () => new Date(), index: true },

    // Translation result (stored even if pending review)
    translatedText: { type: String, required: false, trim: true, maxlength: 2000 },
    providerUsed: { type: String, required: false, trim: true, maxlength: 40 },
    qualityScore: { type: Number, required: false, min: 0, max: 100 },

    strictMode: { type: Boolean, default: false },
    strictTopic: { type: Boolean, default: false, index: true },
    topicTags: { type: [String], default: [] },

    reviewStatus: { type: String, enum: REVIEW_STATUSES, default: 'NONE', index: true },
    reviewedBy: { type: String, required: false, trim: true, maxlength: 120 },
    reviewedAt: { type: Date, required: false },
    reason: { type: String, required: false, trim: true, maxlength: 500 },

    engineUsedByLang: { type: Object, default: {} },
    qaByLang: { type: Object, default: {} },
    reasonsByLang: { type: Object, default: {} },

    lastError: { type: String, required: false },
  },
  { timestamps: true },
);

TranslationJobSchema.index(
  { status: 1, nextRunAt: 1 },
  { name: 'jobs_by_status_nextRunAt' },
);

TranslationJobSchema.index(
  { reviewStatus: 1, createdAt: -1 },
  { name: 'jobs_by_reviewStatus_createdAt' },
);

module.exports = mongoose.models.TranslationJob || mongoose.model('TranslationJob', TranslationJobSchema);
