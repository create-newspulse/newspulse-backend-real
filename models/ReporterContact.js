const mongoose = require('mongoose');

const BEAT_ENUM = [
  'POLITICS',
  'GOVERNANCE',
  'CRIME',
  'COURTS',
  'EDUCATION',
  'HEALTH',
  'BUSINESS',
  'AGRICULTURE',
  'YOUTH',
  'SPORTS',
  'ENTERTAINMENT',
  'TECH',
  'ENVIRONMENT',
  'OTHER',
];

const AREA_TYPE_ENUM = [
  'METRO',
  'CORPORATION',
  'DISTRICT_HQ',
  'TALUKA',
  'TOWN',
  'VILLAGE',
  'OTHER',
];

const STATUS_ENUM = [
  'active',
  'watchlist',
  'suspended',
  'banned',
];

const StatsSchema = new mongoose.Schema({
  totalStories: { type: Number, default: 0 },
  approvedStories: { type: Number, default: 0 },
  pendingStories: { type: Number, default: 0 },
  lastStoryAt: { type: Date },
}, { _id: false });

const ReporterContactSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },

  phoneCountryCode: { type: String, default: '+91' },
  phoneNumber: { type: String, trim: true },
  phoneFull: { type: String, trim: true },

  country: { type: String, default: 'India' },
  stateCode: { type: String, trim: true },
  stateName: { type: String, trim: true },
  districtName: { type: String, trim: true },
  talukaName: { type: String, trim: true },
  cityTownVillage: { type: String, trim: true },

  areaType: { type: String, enum: AREA_TYPE_ENUM, default: 'OTHER' },

  beats: [{ type: String, enum: BEAT_ENUM }],

  status: { type: String, enum: STATUS_ENUM, default: 'active', index: true },

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  stats: { type: StatsSchema, default: () => ({}) },

  notes: { type: String, trim: true },

  // --- Verified Journalist / Media Partner fields ---
  reporterType: { type: String, enum: ['community', 'journalist'], default: 'community', index: true },
  verificationLevel: { type: String, enum: ['community_default', 'pending', 'verified', 'limited', 'revoked'], default: 'community_default', index: true },

  organisationName: { type: String, trim: true },
  organisationType: { type: String, enum: ['print', 'tv', 'radio', 'digital', 'freelance', 'other'] },
  positionTitle: { type: String, trim: true },

  // Separate professional beats list (distinct from existing beats enum list)
  beatsProfessional: [{ type: String, trim: true }],
  yearsExperience: { type: Number },
  languages: [{ type: String, trim: true }],
  interests: [{ type: String, trim: true }],
  heardAbout: { type: String, trim: true },
  journalistCharterAccepted: { type: Boolean, default: false },
  charterAcceptedAt: { type: Date },
  ethicsStrikes: { type: Number, default: 0 },
  behaviourNotes: [{
    note: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: String, trim: true },
  }],
  websiteOrPortfolio: { type: String, trim: true },
  socialLinks: {
    linkedin: { type: String, trim: true },
    twitter: { type: String, trim: true },
  },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  verifiedAt: { type: Date },
}, { timestamps: true });

// Indexes
ReporterContactSchema.index({ email: 1 }, { unique: true });
ReporterContactSchema.index({ phoneFull: 1 });
ReporterContactSchema.index({ stateName: 1, districtName: 1, talukaName: 1, areaType: 1 });
ReporterContactSchema.index({ fullName: 'text', cityTownVillage: 'text', districtName: 'text' });
// Optimized index for journalist application queries
ReporterContactSchema.index({ reporterType: 1, verificationLevel: 1 });

module.exports = mongoose.model('ReporterContact', ReporterContactSchema);
