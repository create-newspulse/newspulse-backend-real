const mongoose = require('mongoose');

const TIERS = [
  'new',
  'contacted',
  'active_contributor',
  'trusted_local',
  'verified_journalist',
  'restricted',
];

const ReporterVerificationSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    tier: { type: String, enum: TIERS, required: true, index: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },

    note: { type: String, trim: true, default: null },

    decidedBy: {
      adminId: { type: String, trim: true, default: null },
      email: { type: String, trim: true, lowercase: true, default: null },
      role: { type: String, trim: true, default: null },
    },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ReporterVerificationSchema.index({ profileId: 1, createdAt: -1 });

module.exports = mongoose.models.ReporterVerification || mongoose.model('ReporterVerification', ReporterVerificationSchema);
module.exports.TIERS = TIERS;
