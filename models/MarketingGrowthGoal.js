const mongoose = require('mongoose');

const MarketingGrowthGoalSchema = new mongoose.Schema(
  {
    goalId: { type: String, required: true, unique: true, index: true, trim: true },
    title: { type: String, required: true, trim: true },
    metric: { type: String, required: true, index: true, trim: true },
    startVerifiedValue: { type: Number, default: null },
    currentVerifiedValue: { type: Number, default: null },
    targetValue: { type: Number, required: true },
    targetDate: { type: Date, required: true, index: true },
    progress: { type: Number, default: null },
    status: { type: String, enum: ['planned', 'active', 'achieved', 'missed', 'paused', 'closed'], default: 'planned', index: true },
    source: { type: String, enum: ['analytics', 'ads_manager', 'combined'], default: 'analytics' },
    lastVerifiedAt: { type: Date, default: null },
    ownerId: { type: String, default: null, index: true, trim: true },
    createdBy: { type: String, default: null, trim: true },
    updatedBy: { type: String, default: null, trim: true },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

MarketingGrowthGoalSchema.index({ metric: 1, status: 1 });
MarketingGrowthGoalSchema.index({ targetDate: 1, status: 1 });

module.exports = mongoose.models.MarketingGrowthGoal || mongoose.model('MarketingGrowthGoal', MarketingGrowthGoalSchema);