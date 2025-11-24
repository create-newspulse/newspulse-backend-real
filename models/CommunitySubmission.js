const mongoose = require('mongoose');

// Phase 1 Community Reporter simplified semantics are layered on top of
// the existing (more advanced) schema. We keep the extended fields for
// forward compatibility but expose a virtual "story" field and map
// simplified statuses via the API layer. (pending -> NEW, approved -> APPROVED, rejected -> REJECTED)
const allowedCategories = ['regional', 'youth', 'campus', 'civic', 'tip', 'other'];
// Phase 2 status enum tightened (TIP_ONLY removed per new spec)
const statusValues = ['NEW', 'AI_REVIEWED', 'PENDING_FOUNDER', 'APPROVED', 'REJECTED'];
const priorityValues = ['FOUNDER_REVIEW', 'EDITOR_REVIEW', 'LOW_PRIORITY'];
const contributorPrefs = ['full_name', 'anonymous', 'group'];

const CommunitySubmissionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  location: { type: String, trim: true },
  category: { type: String, required: true, enum: allowedCategories },
  headline: { type: String, required: true },
  // Underlying body field (Phase 1 "story" maps here). Length restriction relaxed for Phase 1.
  body: { type: String, required: true },
  status: { type: String, enum: statusValues, default: 'NEW' },
  rejectReason: { type: String },
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date },
  // Future / Phase 2 fields
  // Phase 2 AI & policy layer stub fields
  aiHeadline: { type: String }, // mirrors original headline (Phase 2 stub)
  aiBody: { type: String }, // mirrors original body (Phase 2 stub)
  aiTitle: { type: String }, // legacy/backward compatibility (will be deprecated)
  riskScore: { type: Number, default: 0 },
  flags: { type: [String], default: [] },
  priority: { type: String, enum: priorityValues, default: 'EDITOR_REVIEW', index: true },
  contributorPreference: { type: String, enum: contributorPrefs, default: 'anonymous' },
  finalContributorTag: { type: String },
  finalSection: { type: String },
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
  linkedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null, index: true },
}, { timestamps: true });

// Virtual alias so Phase 1 routes can use "story" seamlessly
CommunitySubmissionSchema.virtual('story')
  .get(function() { return this.body; })
  .set(function(v) { this.body = v; });

// Virtual alias for userName expected by simplified API layer
CommunitySubmissionSchema.virtual('userName')
  .get(function() { return this.name; })
  .set(function(v) { this.name = v; });

// Ensure virtuals are included when converting to JSON (for future direct usage)
CommunitySubmissionSchema.set('toJSON', { virtuals: true });
CommunitySubmissionSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
