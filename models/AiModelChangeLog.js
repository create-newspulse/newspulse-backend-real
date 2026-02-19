const mongoose = require('mongoose');

const AiModelChangeLogSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, enum: ['openai', 'gemini'], index: true },
    modeBefore: { type: String, required: false, enum: ['auto', 'pinned', 'latest'], default: null },
    modeAfter: { type: String, required: false, enum: ['auto', 'pinned', 'latest'], default: null },
    modelBefore: { type: String, required: false, default: null },
    modelAfter: { type: String, required: false, default: null },
    reason: {
      type: String,
      required: true,
      enum: ['auto-refresh', 'manual-refresh', 'settings-change', 'rollback', 'deploy', 'error-fallback'],
      index: true,
    },
    env: { type: String, required: true, enum: ['production', 'development'], index: true },
    changedBy: {
      userId: { type: String, required: false, default: null },
      email: { type: String, required: false, default: null },
      role: { type: String, required: false, default: null },
    },
    ip: { type: String, required: false, default: null },
  },
  { timestamps: true }
);

AiModelChangeLogSchema.index({ provider: 1, createdAt: -1 });

module.exports = mongoose.models.AiModelChangeLog || mongoose.model('AiModelChangeLog', AiModelChangeLogSchema);
