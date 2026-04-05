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
  rejectedStories: { type: Number, default: 0 },
  withdrawnStories: { type: Number, default: 0 },
  publishedStories: { type: Number, default: 0 },
  lastStoryAt: { type: Date },
  lastStoryTitle: { type: String, trim: true },
}, { _id: false });

const ReporterContactSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  // Back-compat helper for clients that expect an explicit lowercase field
  emailLower: { type: String, lowercase: true, trim: true, index: true },
  // Legacy identity anchor used by older production indexes and aggregations.
  reporterKey: { type: String, trim: true, index: true },

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

  // Soft-delete / moderation lifecycle (optional)
  suspendedAt: { type: Date },
  suspendedReason: { type: String, trim: true },
  suspendedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.Mixed, default: null },

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  stats: { type: StatsSchema, default: () => ({}) },

  notes: { type: String, trim: true },

  // --- Verified Journalist / Media Partner fields ---
  reporterType: { type: String, enum: ['community', 'journalist'], default: 'community', index: true },
  verificationLevel: { type: String, enum: ['community_default', 'pending', 'verified', 'limited', 'revoked'], default: 'community_default', index: true },
  portalAccessEnabled: { type: Boolean, default: true, index: true },
  portalAuthVersion: { type: Number, default: 0 },
  lastPortalLoginAt: { type: Date, default: null },
  pendingPortalEmail: { type: String, trim: true, lowercase: true, default: null, index: true },
  pendingPortalEmailRequestedAt: { type: Date, default: null },

  organisationName: { type: String, trim: true },
  organisationType: { type: String, enum: ['print', 'tv', 'radio', 'digital', 'freelance', 'other'] },
  positionTitle: { type: String, trim: true },
  // Optional alias to support alternate payloads
  roleOrTitle: { type: String, trim: true },

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
  // Optional array of portfolio links if provided by client
  portfolioLinks: [{ type: String, trim: true }],
  // Internal notes about journalist verification/review
  journalistNotes: { type: String, trim: true },
  socialLinks: {
    linkedin: { type: String, trim: true },
    twitter: { type: String, trim: true },
  },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
  verifiedAt: { type: Date },
}, { timestamps: true });

// Keep emailLower in sync for back-compat and stable lookup keys.
ReporterContactSchema.pre('validate', function(next) {
  try {
    if (!this.emailLower && this.email) {
      this.emailLower = String(this.email).trim().toLowerCase();
    }
    if (!this.reporterKey && (this.emailLower || this.email)) {
      this.reporterKey = String(this.emailLower || this.email).trim().toLowerCase();
    }
  } catch (_) {}
  next();
});

// Indexes
ReporterContactSchema.index({ email: 1 }, { unique: true });
// Unique but safe: ignore docs where emailLower is missing/null.
ReporterContactSchema.index(
  { emailLower: 1 },
  { unique: true, partialFilterExpression: { emailLower: { $type: 'string' } } }
);
ReporterContactSchema.index(
  { reporterKey: 1 },
  { unique: true, partialFilterExpression: { reporterKey: { $type: 'string' } } }
);
ReporterContactSchema.index({ phoneFull: 1 });
ReporterContactSchema.index({ stateName: 1, districtName: 1, talukaName: 1, areaType: 1 });
ReporterContactSchema.index({ fullName: 'text', cityTownVillage: 'text', districtName: 'text' });
// Optimized index for journalist application queries
ReporterContactSchema.index({ reporterType: 1, verificationLevel: 1 });

module.exports = mongoose.model('ReporterContact', ReporterContactSchema);
