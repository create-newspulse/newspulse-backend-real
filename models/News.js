const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  content: String,
  tags: [String],
  category: { type: String, index: true },
  date: { type: Date, default: Date.now },
  imageURL: String,
  views: { type: Number, default: 0 },
  // Admin workflow fields
  status: { type: String, default: 'draft', enum: ['draft', 'scheduled', 'published', 'archived', 'deleted'] },
  scheduledAt: { type: Date, default: null },
  // Provenance (optional)
  source: { type: String, index: true }, // e.g. 'community', 'editor'
  communityReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunitySubmission', index: true },
}, { timestamps: true });

// Virtual alias so UI can use `body` consistently
newsSchema.virtual('body')
  .get(function() { return this.content; })
  .set(function(v) { this.content = v; });

newsSchema.set('toJSON', { virtuals: true });
newsSchema.set('toObject', { virtuals: true });

// Avoid OverwriteModelError when multiple apps import this model.
module.exports = mongoose.models.News || mongoose.model('News', newsSchema);
