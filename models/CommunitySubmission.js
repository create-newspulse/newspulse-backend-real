const mongoose = require('mongoose');

// Phase 1 Community Reporter simplified semantics are layered on top of
// the existing (more advanced) schema. We keep the extended fields for
// forward compatibility but expose a virtual "story" field and map
// simplified statuses via the API layer. (pending -> NEW, approved -> APPROVED, rejected -> REJECTED)
// Relaxed schema: only core fields required; no enums to avoid 500s on new labels.
const CommunitySubmissionSchema = new mongoose.Schema({
  // Core reporter info
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true },
  // Optional aliases preserved for backward compatibility and API expectations
  name: { type: String, required: false, trim: true },
  email: { type: String, required: false, trim: true, lowercase: true },
  userName: { type: String, required: false, trim: true },
  ageGroup: { type: String, required: false, trim: true },
  reporterAgeGroup: { type: String, required: false, trim: true },
  // Location fields
  location: { type: String, required: false, trim: true },
  reporterLocation: { type: String, required: false, trim: true },
  city: { type: String, required: false, trim: true },
  state: { type: String, required: false, trim: true },
  country: { type: String, required: false, trim: true },
  // Submission content
  category: { type: String, required: true, trim: true },
  headline: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true, maxlength: 10000 },
  mediaUrl: { type: String, required: false, trim: true },
  mediaLink: { type: String, required: false, trim: true },
  // Meta / status
  acceptTerms: { type: Boolean, required: false, default: false },
  acceptedPolicy: { type: Boolean, required: false, default: false },
  status: { type: String, required: false, trim: true, default: 'under_review', index: true },
  // Decision metadata
  decisionBy: { type: String, required: false, trim: true },
  rejectReason: { type: String, required: false, trim: true },
  rejectReasonCode: { type: String, required: false, trim: true },
  rejectReasonNote: { type: String, required: false, trim: true },
  // Moderation / analytics (all optional / for future AI)
  aiTitle: { type: String, required: false },
  aiBody: { type: String, required: false },
  riskScore: { type: Number, required: false, default: 0 },
  flags: { type: [String], required: false, default: [] },
  policyNotes: { type: String, required: false, trim: true },
  aiSuggestedCategory: { type: String, required: false, trim: true },
  aiSuggestedTags: { type: [String], required: false, default: [] },
  aiTipOnlySuggested: { type: Boolean, required: false, default: false },
  priority: { type: String, required: false, trim: true },
  contributorPreference: { type: String, required: false, trim: true },
  finalTag: { type: String, required: false, trim: true },
  finalContributorTag: { type: String, required: false, trim: true },
  finalSection: { type: String, required: false, trim: true },
  // Linkage to articles (future)
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: false },
  articleSlug: { type: String, required: false, trim: true },
  linkedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', required: false, default: null, index: true },
  // Reporter identity (optional)
  reporterUserId: { type: String, required: false, trim: true },
  // Request context
  ipAddress: { type: String, required: false, trim: true },
  userAgent: { type: String, required: false, trim: true },
  // Reporter contact (private; editorial-only)
  contact: {
    name: { type: String, trim: true, default: null },
    email: { type: String, trim: true, lowercase: true, default: null, index: true },
    phone: { type: String, trim: true, default: null, index: true },
    preferredContact: { type: String, enum: ['email','phone','whatsapp','no_preference'], default: 'no_preference' },
    canContactForThisStory: { type: Boolean, default: false },
    canContactForFutureStories: { type: Boolean, default: false },
    // Extended social / messaging handles (optional)
    whatsappNumber: { type: String, trim: true },
    telegramId: { type: String, trim: true },
    instagramHandle: { type: String, trim: true },
  },
  // Link to normalized reporter contact directory entry (new Verified Journalist system)
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterContact', index: true },
  // Snapshot of reporter source type at submission time
  sourceType: { type: String, enum: ['community', 'journalist'], default: 'community', index: true },
  // Snapshot of reporter verification level at submission time
  reporterVerificationLevel: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified', index: true },
  // Normalized location (admin directory prefers this)
  location: {
    city: { type: String, trim: true, default: null },
    state: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
  },
  // Report location
  locationDetail: {
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    district: { type: String, trim: true },
  },
}, { timestamps: true });

// Virtual alias so Phase 1 routes can use "story" seamlessly
CommunitySubmissionSchema.virtual('story')
  .get(function() { return this.body; })
  .set(function(v) { this.body = v; });

// NOTE: Do not define a virtual named 'userName' because it conflicts with the real path.
// If a display alias is needed elsewhere, use 'reporterDisplayName' via application-level mapping.
// Safe display virtual preferring contact.name, then userName fallbacks.
CommunitySubmissionSchema.virtual('reporterDisplayName').get(function() {
  return (this.contact && this.contact.name) || this.userName || this.reporterName || this.name || 'Unknown reporter';
});

// Ensure virtuals are included when converting to JSON (for future direct usage)
CommunitySubmissionSchema.set('toJSON', { virtuals: true });
CommunitySubmissionSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
