const mongoose = require('mongoose');

const allowedCategories = ['regional', 'youth', 'campus', 'civic', 'tip', 'other'];
const statusValues = ['NEW', 'AI_REVIEWED', 'PENDING_FOUNDER', 'APPROVED', 'REJECTED', 'TIP_ONLY'];
const contributorPrefs = ['full_name', 'anonymous', 'group'];

const CommunitySubmissionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  location: { type: String, trim: true },
  category: { type: String, required: true, enum: allowedCategories },
  headline: { type: String, required: true },
  body: { type: String, required: true, minlength: 50 },
  status: { type: String, enum: statusValues, default: 'NEW' },
  rejectReason: { type: String },
  // Future / Phase 2 fields
  aiTitle: { type: String },
  aiBody: { type: String },
  riskScore: { type: Number },
  flags: { type: [String], default: [] },
  contributorPreference: { type: String, enum: contributorPrefs, default: 'anonymous' },
  finalContributorTag: { type: String },
  finalSection: { type: String },
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
}, { timestamps: true });

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
