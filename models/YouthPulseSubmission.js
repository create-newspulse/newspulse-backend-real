const mongoose = require('mongoose');

const YouthPulseSubmissionSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    emailNorm: { type: String, default: null, trim: true, lowercase: true, index: true },
    mobile: { type: String, required: true, trim: true },
    college: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    track: { type: String, required: true, trim: true, index: true },
    submissionType: { type: String, required: true, trim: true },
    knowledgeSource: { type: String, default: null, trim: true },
    headline: { type: String, required: true, trim: true, maxlength: 200 },
    storyBody: { type: String, required: true, trim: true, maxlength: 50000 },
    originalLanguage: { type: String, enum: ['en', 'hi', 'gu'], default: 'en', index: true },
    status: {
      type: String,
      enum: ['new', 'under_review', 'approved', 'rejected', 'draft_created', 'published'],
      default: 'new',
      index: true,
    },
    editorialNotes: { type: String, default: null, trim: true },
    verificationNotes: { type: String, default: null, trim: true },
    rejectionReason: { type: String, default: null, trim: true },
    linkedDraftId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null, index: true },
    linkedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null, index: true },
    contributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'YouthPulseContributor', default: null, index: true },
    sourceType: { type: String, default: 'youth_pulse', index: true },
    sourceLabel: { type: String, default: 'Youth Pulse Community', trim: true },
    optionalSourceLinks: { type: [String], default: [] },
    optionalAttachmentUrls: { type: [String], default: [] },
    moderationFlags: { type: [String], default: [] },
    riskLevel: { type: String, default: 'low', trim: true },
    reviewedBy: { type: String, default: null, trim: true },
    approvedBy: { type: String, default: null, trim: true },
    publishedAt: { type: Date, default: null, index: true },
    ipAddress: { type: String, default: null, trim: true },
    userAgent: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

YouthPulseSubmissionSchema.pre('validate', function preValidate(next) {
  try {
    if (this.email) {
      this.emailNorm = String(this.email).trim().toLowerCase();
    }
  } catch (_) {}
  next();
});

module.exports = mongoose.models.YouthPulseSubmission || mongoose.model('YouthPulseSubmission', YouthPulseSubmissionSchema);