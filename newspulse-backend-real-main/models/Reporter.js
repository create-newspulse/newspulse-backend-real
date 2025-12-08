const mongoose = require('mongoose');

const ReporterSchema = new mongoose.Schema(
  {
    fullName: String,
    email: { type: String, index: true },
    phone: String,

    city: String,
    state: String,
    country: String,

    languages: [String],
    beats: [String],

    type: {
      type: String,
      enum: ['community', 'journalist'],
      default: 'community',
    },
    verificationStatus: {
      type: String,
      enum: ['none', 'pending', 'verified', 'rejected'],
      default: 'none',
    },

    status: {
      type: String,
      enum: ['active', 'blocked', 'archived'],
      default: 'active',
    },
    strikes: { type: Number, default: 0 },

    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.models.Reporter || mongoose.model('Reporter', ReporterSchema);
