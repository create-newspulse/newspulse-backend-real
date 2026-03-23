const mongoose = require('mongoose');

const COVERAGE_SCOPES = ['hyperlocal', 'regional', 'national', 'international'];

const ReporterCoverageSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    coverageScope: { type: String, enum: COVERAGE_SCOPES, default: 'hyperlocal', index: true },

    country: { type: String, trim: true, default: null, index: true },
    stateProvince: { type: String, trim: true, default: null, index: true },
    districtCounty: { type: String, trim: true, default: null, index: true },
    city: { type: String, trim: true, default: null, index: true },
    areaLocality: { type: String, trim: true, default: null },

    isPrimary: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ReporterCoverageSchema.index({ profileId: 1, isPrimary: 1 });

module.exports = mongoose.models.ReporterCoverage || mongoose.model('ReporterCoverage', ReporterCoverageSchema);
module.exports.COVERAGE_SCOPES = COVERAGE_SCOPES;
