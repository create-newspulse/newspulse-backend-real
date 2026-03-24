const mongoose = require('mongoose');

const LOCATION_SCHEMA = new mongoose.Schema(
  {
    country: { type: String, trim: true, default: null, index: true },
    stateProvince: { type: String, trim: true, default: null, index: true },
    districtCounty: { type: String, trim: true, default: null, index: true },
    city: { type: String, trim: true, default: null, index: true },
    areaLocality: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const STATS_SCHEMA = new mongoose.Schema(
  {
    totalStories: { type: Number, default: 0 },
    approvedStories: { type: Number, default: 0 },
    pendingStories: { type: Number, default: 0 },
    rejectedStories: { type: Number, default: 0 },
    withdrawnStories: { type: Number, default: 0 },
    publishedStories: { type: Number, default: 0 },
    lastStoryAt: { type: Date, default: null, index: true },
    lastStoryTitle: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const VERIFICATION_TIERS = [
  'new',
  'contacted',
  'active_contributor',
  'trusted_local',
  'verified_journalist',
  'restricted',
];

const COVERAGE_SCOPES = ['hyperlocal', 'regional', 'national', 'international'];

const ReporterProfileSchema = new mongoose.Schema(
  {
    displayName: { type: String, trim: true, default: 'Unknown' },

    // Highest priority stable identity when available (authenticated submitter)
    userId: { type: String, trim: true, default: null, index: true },

    // Stable link to the reporter directory entry when submission used ReporterContact
    reporterContactId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterContact', default: null, index: true },

    primaryEmail: { type: String, trim: true, lowercase: true, default: null, index: true },
    primaryPhone: { type: String, trim: true, default: null, index: true },

    status: { type: String, enum: ['active', 'inactive', 'archived'], default: 'active', index: true },
    labels: { type: [String], default: [], index: true },

    // Flags: missing_email, missing_phone, missing_location, identity_unresolved
    flags: { type: [String], default: [], index: true },

    verificationTier: { type: String, enum: VERIFICATION_TIERS, default: 'new', index: true },

    coverageScope: { type: String, enum: COVERAGE_SCOPES, default: 'hyperlocal', index: true },
    location: { type: LOCATION_SCHEMA, default: () => ({}) },

    stats: { type: STATS_SCHEMA, default: () => ({}) },

    mergedIntoProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', default: null, index: true },
  },
  { timestamps: true }
);

ReporterProfileSchema.index({ userId: 1 }, { sparse: true });
ReporterProfileSchema.index({ reporterContactId: 1 }, { sparse: true });
ReporterProfileSchema.index({ primaryEmail: 1 }, { sparse: true });
ReporterProfileSchema.index({ primaryPhone: 1 }, { sparse: true });

module.exports = mongoose.models.ReporterProfile || mongoose.model('ReporterProfile', ReporterProfileSchema);
module.exports.VERIFICATION_TIERS = VERIFICATION_TIERS;
module.exports.COVERAGE_SCOPES = COVERAGE_SCOPES;
