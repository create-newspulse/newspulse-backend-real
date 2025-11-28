// models/CommunitySubmission.js
const mongoose = require("mongoose");

const CommunitySubmissionSchema = new mongoose.Schema(
  {
    // Phase 1 – basic reporter info
    userName: { type: String, required: true },
    email: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String },
    country: { type: String },

    // Age band is safer than exact age (future use)
    ageGroup: {
      type: String,
      enum: ["UNDER_18", "18_24", "25_34", "35_44", "45_PLUS"],
    },

    // Story
    headline: { type: String, required: true },
    body: { type: String, required: true },
    category: { type: String, required: true },
    mediaLink: { type: String },

    // Status
    status: {
      type: String,
      enum: ["NEW", "UNDER_REVIEW", "AI_REVIEWED", "PENDING_FOUNDER", "APPROVED", "REJECTED", "TIP_ONLY"],
      default: "NEW",
    },

    // AI & policy (future use)
    aiTitle: { type: String },
    aiBody: { type: String },
    riskScore: { type: Number },
    flags: [{ type: String }],
    policyNotes: { type: String },

    // Contributor / credit (future use)
    contributorPreference: {
      type: String,
      enum: ["FULL_NAME", "ANONYMOUS", "GROUP_TAG"],
    },
    preferredGroupTag: { type: String },
    finalTag: { type: String },

    // Publication link (future use)
    articleId: { type: String },
    articleSlug: { type: String },

    // Decision meta (future use)
    decisionBy: { type: String },
    rejectReasonCode: {
      type: String,
      enum: ["NOT_ENOUGH_EVIDENCE", "VIOLATES_POLICY", "NOT_NEWS_FORMAT", "OTHER"],
    },
    rejectReasonNote: { type: String },

    // Extra meta (future use)
    reporterUserId: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  {
    timestamps: true, // createdAt & updatedAt automatically
  }
);

// IMPORTANT: no virtual('userName') here → no conflict
module.exports =
  mongoose.models.CommunitySubmission ||
  mongoose.model("CommunitySubmission", CommunitySubmissionSchema);

