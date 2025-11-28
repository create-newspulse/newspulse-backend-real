const mongoose = require('mongoose');

// Phase 1 Community Reporter simplified semantics are layered on top of
// the existing (more advanced) schema. We keep the extended fields for
// forward compatibility but expose a virtual "story" field and map
// simplified statuses via the API layer. (pending -> NEW, approved -> APPROVED, rejected -> REJECTED)
// Relaxed schema: only core fields required; no enums to avoid 500s on new labels.
const CommunitySubmissionSchema = new mongoose.Schema({
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true },
  // Optional aliases preserved for backward compatibility
  name: { type: String, required: false, trim: true },
  email: { type: String, required: false, trim: true, lowercase: true },
  ageGroup: { type: String, required: false, trim: true },
  reporterAgeGroup: { type: String, required: false, trim: true },
  location: { type: String, required: false, trim: true },
  reporterLocation: { type: String, required: false, trim: true },
  city: { type: String, required: false, trim: true },
  category: { type: String, required: true, trim: true }, // no enum
  headline: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true }, // underlying story storage
  mediaUrl: { type: String, required: false, trim: true },
  mediaLink: { type: String, required: false, trim: true },
  acceptTerms: { type: Boolean, required: false, default: false },
  acceptedPolicy: { type: Boolean, required: false, default: false },
  status: { type: String, required: false, trim: true, default: 'under_review', index: true },
  rejectReason: { type: String, required: false, trim: true },
  // Moderation / analytics (all optional)
  riskScore: { type: Number, required: false, default: 0 },
  flags: { type: [String], required: false, default: [] },
  priority: { type: String, required: false, trim: true },
  contributorPreference: { type: String, required: false, trim: true },
  finalContributorTag: { type: String, required: false, trim: true },
  finalSection: { type: String, required: false, trim: true },
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: false },
  linkedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', required: false, default: null, index: true },
}, { timestamps: true });

// Virtual alias so Phase 1 routes can use "story" seamlessly
CommunitySubmissionSchema.virtual('story')
  .get(function() { return this.body; })
  .set(function(v) { this.body = v; });

// Virtual alias for userName expected by simplified API layer
CommunitySubmissionSchema.virtual('userName')
  .get(function() { return this.reporterName || this.name; })
  .set(function(v) { this.reporterName = v; this.name = v; });

// Ensure virtuals are included when converting to JSON (for future direct usage)
CommunitySubmissionSchema.set('toJSON', { virtuals: true });
CommunitySubmissionSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
