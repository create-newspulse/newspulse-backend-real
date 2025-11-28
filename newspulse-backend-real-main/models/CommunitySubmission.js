const mongoose = require('mongoose');

// Minimal Phase 1 Community Reporter schema
// Mirrors style of existing News model export pattern.
// Relaxed duplicate schema (aligns with primary): minimal required fields, no enums.
const communitySubmissionSchema = new mongoose.Schema({
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true },
  userName: { type: String, required: false, trim: true },
  email: { type: String, required: false, trim: true, lowercase: true },
  ageGroup: { type: String, required: false, trim: true },
  reporterAgeGroup: { type: String, required: false, trim: true },
  location: { type: String, required: false, trim: true },
  reporterLocation: { type: String, required: false, trim: true },
  category: { type: String, required: true, trim: true },
  headline: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true },
  mediaLink: { type: String, required: false, trim: true },
  acceptTerms: { type: Boolean, required: false, default: false },
  acceptedPolicy: { type: Boolean, required: false, default: false },
  status: { type: String, required: false, trim: true, default: 'under_review' },
  aiHeadline: { type: String, required: false },
  aiBody: { type: String, required: false },
  riskScore: { type: Number, required: false, default: 0 },
  flags: { type: [String], required: false, default: [] },
  rejectReason: { type: String, required: false, trim: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('CommunitySubmission', communitySubmissionSchema);
