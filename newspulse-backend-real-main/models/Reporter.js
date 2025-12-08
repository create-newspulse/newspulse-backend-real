const mongoose = require('mongoose');

const ReporterSchema = new mongoose.Schema(
  {
    fullName: String,
    email: { type: String, index: true },
    phone: String,

    city: String,
    state: String,
    country: String,
    district: { type: String, trim: true },
    areaType: {
      type: String,
      enum: ['metro', 'corporation', 'district_hq', 'taluka', 'village', 'other'],
    },

    languages: [String],
    beats: [{ type: String, trim: true }],

    type: {
      type: String,
      enum: ['community', 'journalist'],
      default: 'community',
    },
    verificationStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'limited', 'revoked'],
      default: 'unverified',
    },

    // Journalist fields
    organisation: { type: String, trim: true },
    roleOrTitle: { type: String, trim: true },
    yearsExperience: { type: Number },
    portfolioLinks: [{ type: String, trim: true }],
    journalistNotes: { type: String, trim: true },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    ethicsStrikes: { type: Number, default: 0 },

    status: {
      type: String,
      // Include legacy values to avoid breaking existing docs
      enum: ['active', 'on_leave', 'inactive', 'blacklisted', 'watchlist', 'blocked', 'archived'],
      default: 'active',
      index: true,
    },
    strikes: { type: Number, default: 0 },

    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.models.Reporter || mongoose.model('Reporter', ReporterSchema);
