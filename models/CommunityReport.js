const mongoose = require('mongoose');

const CommunityReportSchema = new mongoose.Schema({
  // Reporter info
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
  reporterPhone: { type: String, trim: true },
  reporterCity: { type: String, trim: true },
  reporterState: { type: String, trim: true },
  reporterCountry: { type: String, trim: true },
  reporterType: { type: String, enum: ['community', 'professional'], default: 'community' },

  // Story info
  category: { type: String, required: true, trim: true },
  headline: { type: String, required: true, trim: true },
  storyText: { type: String, required: true, trim: true },
  ageGroup: { type: String, trim: true },
  preferredLanguages: { type: [String], default: [] },

  // System / workflow
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], default: 'pending', index: true },
  referenceId: { type: String, trim: true, unique: true, sparse: true },
  aiRiskScore: { type: Number, default: 0 },
  aiFlagsCount: { type: Number, default: 0 },
  reviewNotes: { type: String, trim: true },
}, { timestamps: true });

// Compound index for reporter queries
CommunityReportSchema.index({ reporterEmail: 1, createdAt: -1 });

// Simple human-friendly referenceId generator if not set
CommunityReportSchema.pre('save', function(next) {
  if (!this.referenceId) {
    const year = new Date().getFullYear();
    const tail = Date.now().toString().slice(-4);
    this.referenceId = `NP-CR-${year}-${tail}`;
  }
  next();
});

module.exports = mongoose.models.CommunityReport || mongoose.model('CommunityReport', CommunityReportSchema);
