const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  content: String,
  tags: [String],
  category: { type: String, index: true },
  date: { type: Date, default: Date.now, index: true },
  imageURL: String,
  views: { type: Number, default: 0 },
  // Admin workflow fields
  status: { type: String, enum: ['draft','scheduled','published','archived','deleted'], default: 'draft', index: true },
  language: { type: String, default: 'en', index: true },
  scheduledAt: { type: Date },
  // Provenance (optional)
  source: { type: String, index: true }, // e.g. 'community', 'editor'
  communityReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunitySubmission', index: true },
});

module.exports = mongoose.model('News', newsSchema);
