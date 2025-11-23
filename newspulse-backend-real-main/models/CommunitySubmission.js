const mongoose = require('mongoose');

// Minimal Phase 1 Community Reporter schema
// Mirrors style of existing News model export pattern.
const STATUS = ['NEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'];

const communitySubmissionSchema = new mongoose.Schema({
  userName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  location: { type: String, trim: true },
  category: { type: String, trim: true },
  headline: { type: String, required: true },
  body: { type: String, required: true },
  mediaLink: { type: String, trim: true },
  status: { type: String, enum: STATUS, default: 'NEW' },
  rejectReason: { type: String, trim: true }, // optional when rejecting
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CommunitySubmission', communitySubmissionSchema);
