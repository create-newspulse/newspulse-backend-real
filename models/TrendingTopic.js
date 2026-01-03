const mongoose = require('mongoose');

const TrendingTopicSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    href: { type: String, required: true, trim: true },
    colorKey: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

TrendingTopicSchema.index({ key: 1 }, { unique: true });
TrendingTopicSchema.index({ order: 1 });

module.exports = mongoose.models.TrendingTopic || mongoose.model('TrendingTopic', TrendingTopicSchema);
