const mongoose = require('mongoose');

// Phase 1 Community Reporter simplified semantics are layered on top of
// the existing (more advanced) schema. We keep the extended fields for
// forward compatibility and accept Phase-1 "story" via an alias to "body".
// simplified statuses via the API layer. (pending -> NEW, approved -> APPROVED, rejected -> REJECTED)
// Relaxed schema: only core fields required; no enums to avoid 500s on new labels.
const CommunitySubmissionSchema = new mongoose.Schema({
  // Core reporter info
  reporterName: { type: String, required: true, trim: true },
  reporterEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
  // Normalized reporter email for consistent lookups
  reporterEmailNorm: { type: String, required: false, index: true },
  // Optional aliases preserved for backward compatibility and API expectations
  // Phase-1 fields (frontend sends these). We make them required but backfill
  // them automatically from reporterName/reporterEmail for compatibility.
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  userName: { type: String, required: false, trim: true },
  // Phase-1 required; provide safe default for legacy endpoints that don't send it.
  ageGroup: { type: String, required: true, trim: true, default: 'UNKNOWN' },
  reporterAgeGroup: { type: String, required: false, trim: true },
  // Location fields (string legacy fields remain optional for back-compat)
  reporterLocation: { type: String, required: false, trim: true },
  city: { type: String, required: false, trim: true },
  state: { type: String, required: false, trim: true },
  country: { type: String, required: false, trim: true },
  // Submission content
  category: { type: String, required: false, trim: true, default: null },
  headline: { type: String, required: true, trim: true, maxlength: 200 },
  // Use `body` as the stored field; accept `story` as an alias so Phase-1 payloads
  // can send { story: "..." } without causing validation errors.
  body: { type: String, required: true, trim: true, maxlength: 50000, alias: 'story' },
  mediaUrl: { type: String, required: false, trim: true },
  mediaLink: { type: String, required: false, trim: true },
  // Meta / status
  acceptTerms: { type: Boolean, required: false, default: false },
  acceptedPolicy: { type: Boolean, required: false, default: false },
  // Default aligns with Phase-1 endpoint; legacy endpoints may set other status labels.
  status: { type: String, required: false, trim: true, default: 'NEW', index: true },
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

  // Contributor network (phase-1): canonical reporter profile link + identity diagnostics
  reporterProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: false, default: null, index: true },
  identityFlags: { type: [String], required: false, default: [], index: true },
  identityResolutionMethod: { type: String, required: false, trim: true, default: null },
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
  reporterVerificationLevel: { type: String, enum: ['unverified', 'journalist_pending', 'journalist_verified'], default: 'unverified', index: true },
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
  // Withdrawal tracking
  withdrawnAt: { type: Date, required: false },

  // Soft delete (two-stage delete model)
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null, index: true },
  deletedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  previousStatus: { type: String, required: false, trim: true, default: null },
  restoredAt: { type: Date, default: null },
  restoredBy: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

// NOTE: Do not define a virtual named 'userName' because it conflicts with the real path.
// If a display alias is needed elsewhere, use 'reporterDisplayName' via application-level mapping.
// Safe display virtual preferring contact.name, then userName fallbacks.
CommunitySubmissionSchema.virtual('reporterDisplayName').get(function() {
  return (this.contact && this.contact.name) || this.userName || this.reporterName || this.name || 'Unknown reporter';
});

// Ensure virtuals are included when converting to JSON (for future direct usage)
CommunitySubmissionSchema.set('toJSON', { virtuals: true });
CommunitySubmissionSchema.set('toObject', { virtuals: true });

// Ensure reporterEmailNorm is always normalized before save
CommunitySubmissionSchema.pre('save', function(next) {
  try {
    if (this.reporterEmail) {
      this.reporterEmailNorm = String(this.reporterEmail).trim().toLowerCase();
    } else if (this.email) {
      this.reporterEmailNorm = String(this.email).trim().toLowerCase();
    } else if (this.contact && this.contact.email) {
      this.reporterEmailNorm = String(this.contact.email).trim().toLowerCase();
    }
  } catch (_) {}
  next();
});

// Backfill Phase-1 aliases before validation so required(name/email) never 500s
// when legacy endpoints only provide reporterName/reporterEmail.
CommunitySubmissionSchema.pre('validate', function(next) {
  try {
    if (!this.name && this.reporterName) this.name = String(this.reporterName).trim();
    if (!this.email && this.reporterEmail) this.email = String(this.reporterEmail).trim().toLowerCase();

    // Prefer explicit ageGroup, else fall back to reporterAgeGroup, else keep default.
    if ((!this.ageGroup || this.ageGroup === 'UNKNOWN') && this.reporterAgeGroup) {
      this.ageGroup = String(this.reporterAgeGroup).trim();
    }
  } catch (_) {}
  next();
});

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
