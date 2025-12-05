const mongoose = require('mongoose');

const CommunityStorySchema = new mongoose.Schema({
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
  reporterPhone: { type: String, trim: true },
  reporterCity: { type: String, trim: true },
  reporterState: { type: String, trim: true },
  reporterCountry: { type: String, trim: true },
  reporterType: { type: String, enum: ['community', 'professional'], default: 'community' },
  category: { type: String, required: true, trim: true },
  headline: { type: String, required: true, trim: true },
  storyText: { type: String, required: true, trim: true },
  ageGroup: { type: String, trim: true },
  preferredLanguages: { type: [String], default: [] },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
}, { timestamps: true });

CommunityStorySchema.index({ reporterEmail: 1, createdAt: -1 });

module.exports = mongoose.models.CommunityStory || mongoose.model('CommunityStory', CommunityStorySchema);
