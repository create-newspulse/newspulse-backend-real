const mongoose = require('mongoose');

// Phase 1 Community Reporter simplified semantics are layered on top of
// the existing (more advanced) schema. We keep the extended fields for
// forward compatibility and accept Phase-1 "story" via an alias to "body".
// simplified statuses via the API layer. (pending -> NEW, approved -> APPROVED, rejected -> REJECTED)
// Relaxed schema: only core fields required; no enums to avoid 500s on new labels.
const CommunitySubmissionSchema = new mongoose.Schema({
  // Core reporter info
  fullName: { type: String, required: false, trim: true },
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
  district: { type: String, required: false, trim: true },
  state: { type: String, required: false, trim: true },
  country: { type: String, required: false, trim: true },
  area: { type: String, required: false, trim: true },
  areaType: { type: String, required: false, trim: true },
  coverageScope: { type: String, required: false, trim: true },
  beat: { type: String, required: false, trim: true },
  organisationName: { type: String, required: false, trim: true },
  organisationType: { type: String, required: false, trim: true },
  portalAuthStatus: { type: String, required: false, trim: true },
  portalAccessEnabled: { type: Boolean, required: false, default: undefined },
  portalAuthVersion: { type: Number, required: false, default: undefined },
  phone: { type: String, required: false, trim: true },
  phoneNumber: { type: String, required: false, trim: true },
  mobile: { type: String, required: false, trim: true },
  college: { type: String, required: false, trim: true },
  mobileNumber: { type: String, required: false, trim: true },
  contactNumber: { type: String, required: false, trim: true },
  whatsapp: { type: String, required: false, trim: true },
  whatsappNumber: { type: String, required: false, trim: true },
  // Submission content
  desk: { type: String, required: false, trim: true, default: null, index: true },
  submissionType: { type: String, required: false, trim: true, default: null, index: true },
  intakeSource: { type: String, required: false, trim: true, default: null, index: true },
  track: { type: String, required: false, trim: true, default: null, index: true },
  category: { type: String, required: false, trim: true, default: null },
  headline: { type: String, required: true, trim: true, maxlength: 200 },
  storyBody: { type: String, required: false, trim: true, maxlength: 50000 },
  // Use `body` as the stored field; accept `story` as an alias so Phase-1 payloads
  // can send { story: "..." } without causing validation errors.
  body: { type: String, required: true, trim: true, maxlength: 50000, alias: 'story' },
  originalLanguage: { type: String, required: false, trim: true, default: null, index: true },
  firstHandClaim: { type: Boolean, required: false, default: false },
  optionalSourceLinks: { type: [String], required: false, default: [] },
  optionalAttachmentUrls: { type: [String], required: false, default: [] },
  mediaUrl: { type: String, required: false, trim: true },
  mediaLink: { type: String, required: false, trim: true },
  attachments: {
    type: [
      {
        url: { type: String, trim: true, required: true },
        name: { type: String, trim: true, default: null },
        mimeType: { type: String, trim: true, default: null },
        size: { type: Number, default: null },
        kind: { type: String, trim: true, default: null },
      },
    ],
    required: false,
    default: [],
  },
  // Meta / status
  acceptTerms: { type: Boolean, required: false, default: false },
  acceptedPolicy: { type: Boolean, required: false, default: false },
  confirmTruthful: { type: Boolean, required: false, default: false },
  confirmRightsToShare: { type: Boolean, required: false, default: false },
  confirmEditorialReviewAllowed: { type: Boolean, required: false, default: false },
  confirmNoUnsafeFalseAbusiveContent: { type: Boolean, required: false, default: false },
  // Default aligns with Phase-1 endpoint; legacy endpoints may set other status labels.
  status: { type: String, required: false, trim: true, default: 'NEW', index: true },
  moderationFlags: { type: [String], required: false, default: [] },
  riskLevel: { type: String, required: false, trim: true, default: null, index: true },
  verificationNotes: { type: String, required: false, trim: true },
  editorialNotes: { type: String, required: false, trim: true },
  rejectionReason: { type: String, required: false, trim: true },
  cleanedHeadline: { type: String, required: false, trim: true, maxlength: 200 },
  cleanedSummary: { type: String, required: false, trim: true, maxlength: 600 },
  cleanedBody: { type: String, required: false, trim: true, maxlength: 50000 },
  selectedPublicTrack: { type: String, required: false, trim: true, default: null, index: true },
  reviewedBy: { type: String, required: false, trim: true },
  approvedBy: { type: String, required: false, trim: true },
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
  linkedArticleSlug: { type: String, required: false, trim: true, default: null },
  publishedAt: { type: Date, required: false, default: null, index: true },
  originType: { type: String, required: false, trim: true, default: null, index: true },
  publicLabel: { type: String, required: false, trim: true, default: null },
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

CommunitySubmissionSchema.virtual('displayTrack').get(function() {
  try {
    const { getTrackLabel } = require('../services/youthPulseSubmission.service');
    return getTrackLabel(this.selectedPublicTrack || this.track) || this.publicLabel || this.category || null;
  } catch (_) {
    return this.publicLabel || this.category || null;
  }
});

CommunitySubmissionSchema.virtual('displayStatus').get(function() {
  try {
    const { formatDisplayStatus } = require('../services/youthPulseSubmission.service');
    return formatDisplayStatus(this.status);
  } catch (_) {
    return this.status || null;
  }
});

CommunitySubmissionSchema.virtual('contributorDisplayName').get(function() {
  return this.fullName || (this.contact && this.contact.name) || this.userName || this.reporterName || this.name || null;
});

CommunitySubmissionSchema.virtual('articleLinked').get(function() {
  return !!this.linkedArticleId;
});

// Ensure virtuals are included when converting to JSON (for future direct usage)
CommunitySubmissionSchema.set('toJSON', { virtuals: true });
CommunitySubmissionSchema.set('toObject', { virtuals: true });

// Ensure reporterEmailNorm is always normalized before save
CommunitySubmissionSchema.pre('save', function(next) {
  try {
    if (this.fullName && !this.reporterName) this.reporterName = String(this.fullName).trim();
    if (this.fullName && !this.name) this.name = String(this.fullName).trim();
    if (this.storyBody && !this.body) this.body = String(this.storyBody).trim();
    if (this.body && !this.storyBody) this.storyBody = String(this.body).trim();
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
    const {
      extractSubmissionAttachments,
      inferSubmissionDeskMetadata,
      normalizeTrackValue,
    } = require('../services/communitySubmissionWorkflow');

    if (!this.fullName && this.reporterName) this.fullName = String(this.reporterName).trim();
    if (!this.name && this.reporterName) this.name = String(this.reporterName).trim();
    if (!this.reporterName && this.fullName) this.reporterName = String(this.fullName).trim();
    if (!this.name && this.fullName) this.name = String(this.fullName).trim();
    if (!this.email && this.reporterEmail) this.email = String(this.reporterEmail).trim().toLowerCase();
    if (!this.reporterEmail && this.email) this.reporterEmail = String(this.email).trim().toLowerCase();
    if (!this.storyBody && this.body) this.storyBody = String(this.body).trim();
    if (!this.body && this.storyBody) this.body = String(this.storyBody).trim();

    // Prefer explicit ageGroup, else fall back to reporterAgeGroup, else keep default.
    if ((!this.ageGroup || this.ageGroup === 'UNKNOWN') && this.reporterAgeGroup) {
      this.ageGroup = String(this.reporterAgeGroup).trim();
    }

    const meta = inferSubmissionDeskMetadata(this.toObject ? this.toObject() : this);
    if (meta.desk && !this.desk) this.desk = meta.desk;
    if (meta.submissionType && !this.submissionType) this.submissionType = meta.submissionType;
    if (meta.intakeSource && !this.intakeSource) this.intakeSource = meta.intakeSource;

    const normalizedTrack = meta.track || normalizeTrackValue(this.track || this.category);
    if (normalizedTrack && !this.track) this.track = normalizedTrack;
    if (!this.category && normalizedTrack) this.category = normalizedTrack;
    if (!this.selectedPublicTrack && normalizedTrack) this.selectedPublicTrack = normalizedTrack;
    if (!this.publicLabel && normalizedTrack) {
      const labelMap = {
        'youth-pulse': 'Youth Pulse',
        'campus-buzz': 'Campus Buzz',
        'govt-exam-updates': 'Govt Exam Updates',
        'career-boosters': 'Career Boosters',
        'young-achievers': 'Young Achievers',
        'student-voices': 'Student Voices',
      };
      this.publicLabel = labelMap[normalizedTrack] || this.publicLabel;
    }

    if ((!this.mediaUrl || !this.mediaLink || !Array.isArray(this.attachments) || !this.attachments.length)) {
      const attachments = extractSubmissionAttachments(this.toObject ? this.toObject() : this);
      if (attachments.length && (!Array.isArray(this.attachments) || !this.attachments.length)) {
        this.attachments = attachments;
      }
      const primaryAttachment = attachments[0] || (Array.isArray(this.attachments) ? this.attachments[0] : null);
      if (primaryAttachment && primaryAttachment.url) {
        if (!this.mediaUrl) this.mediaUrl = primaryAttachment.url;
        if (!this.mediaLink) this.mediaLink = primaryAttachment.url;
      }
    }
    if ((!Array.isArray(this.optionalAttachmentUrls) || !this.optionalAttachmentUrls.length) && Array.isArray(this.attachments) && this.attachments.length) {
      this.optionalAttachmentUrls = this.attachments.map((item) => item && item.url).filter(Boolean);
    }
  } catch (_) {}
  next();
});

// Best-effort normalization/upsert so contributor directory is populated from submissions.
// Never throws (to avoid breaking Community Story Desk flows).
CommunitySubmissionSchema.post('save', async function(doc) {
  try {
    if (!doc || !doc._id) return;
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;

    // 1) Upsert ReporterContact (email-keyed) and backfill submission.reporterId
    try {
      const { upsertReporterContactFromSubmission } = require('../services/reporterContactService');
      const out = await upsertReporterContactFromSubmission(doc.toObject ? doc.toObject() : doc);
      if (out && out.contactId && !doc.reporterId) {
        try { doc.reporterId = out.contactId; } catch (_) {}
        await mongoose.model('CommunitySubmission').updateOne(
          { _id: doc._id },
          { $set: { reporterId: out.contactId } }
        ).catch(() => {});
      }

      if (process.env.REPORTER_NORMALIZE_LOG === '1') {
        console.log('[community-submission][contact-upserted]', {
          submissionId: String(doc._id),
          reporterId: out && out.contactId ? String(out.contactId) : null,
        });
      }
    } catch (_) {}

    // 2) Resolve + attach ReporterProfile, then recompute stats
    try {
      const {
        resolveAndAttachForSubmission,
        recomputeReporterProfileStoryStats,
      } = require('../services/reporterIdentityResolution.service');

      const link = await resolveAndAttachForSubmission(doc);
      const profileId = (doc.reporterProfileId ? String(doc.reporterProfileId) : null) || link?.profileId || null;
      if (profileId) {
        await recomputeReporterProfileStoryStats(profileId, { reason: 'submission-saved' }).catch(() => {});
      }

      if (process.env.REPORTER_NORMALIZE_LOG === '1') {
        console.log('[community-submission][reporter-normalized]', {
          submissionId: String(doc._id),
          reporterProfileId: profileId,
          resolutionMethod: link?.resolutionMethod || null,
          identityFlags: Array.isArray(link?.flags) ? link.flags : undefined,
        });
      }
    } catch (_) {}
  } catch (_) {}
});

module.exports = mongoose.models.CommunitySubmission || mongoose.model('CommunitySubmission', CommunitySubmissionSchema);
