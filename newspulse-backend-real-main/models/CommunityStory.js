const mongoose = require('mongoose');

const CommunityStorySchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reporter' },

  source: { type: String, enum: ['community', 'journalist'], default: 'community' },

  category: { type: String, trim: true },
  headline: { type: String, trim: true },
  body: { type: String, trim: true },
  ageGroup: { type: String, trim: true },

  storyCity: { type: String, trim: true },
  storyState: { type: String, trim: true },
  storyCountry: { type: String, trim: true },

  priority: { type: String, enum: ['normal', 'high'], default: 'normal' },
  risk: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },

  status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], default: 'pending', index: true },
}, { timestamps: true });

CommunityStorySchema.index({ reporterId: 1, createdAt: -1 });

module.exports = mongoose.models.CommunityStory || mongoose.model('CommunityStory', CommunityStorySchema);
