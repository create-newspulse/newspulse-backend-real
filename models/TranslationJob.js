const mongoose = require('mongoose');

const STATUS_VALUES = ['queued', 'running', 'done', 'translating', 'completed', 'partially_completed', 'failed', 'review_required'];

const translationJobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    newsId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    status: { type: String, enum: STATUS_VALUES, default: 'queued', index: true },
    runAt: { type: Date, default: () => new Date(), index: true },

    lockedAt: { type: Date, default: null, index: true },
    lockedBy: { type: String, default: null },

    attempts: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    failureReason: { type: String, default: null },
    provider: { type: String, default: null, index: true },
    sourceLanguage: { type: String, default: null, index: true },
    targetLanguages: { type: [String], default: [] },
    sourceHash: { type: String, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    requestedBy: { type: String, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Only one job per newsId+type; reuse by updating status/runAt.
translationJobSchema.index({ type: 1, newsId: 1 }, { unique: true });
translationJobSchema.index({ type: 1, status: 1, runAt: 1 });

module.exports = mongoose.models.TranslationJob || mongoose.model('TranslationJob', translationJobSchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
