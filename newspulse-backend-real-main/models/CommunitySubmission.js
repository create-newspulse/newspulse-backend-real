const mongoose = require('mongoose');

// Minimal Phase 1 Community Reporter schema
// Mirrors style of existing News model export pattern.
// Phase 2 unified status enum
const STATUS = ['NEW', 'AI_REVIEWED', 'PENDING_FOUNDER', 'APPROVED', 'REJECTED'];

const communitySubmissionSchema = new mongoose.Schema({
  userName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  location: { type: String, trim: true },
  category: { type: String, trim: true },
  headline: { type: String, required: true },
  body: { type: String, required: true },
  mediaLink: { type: String, trim: true },
  // Phase 2 AI fields (stub values copied from originals)
  aiHeadline: { type: String },
  aiBody: { type: String },
  riskScore: { type: Number, default: 0 },
  flags: { type: [String], default: [] },
  status: { type: String, enum: STATUS, default: 'NEW' },
  rejectReason: { type: String, trim: true }, // optional when rejecting
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('CommunitySubmission', communitySubmissionSchema);
