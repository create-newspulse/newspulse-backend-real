const mongoose = require('mongoose');

const ReporterMergeQueueSchema = new mongoose.Schema(
  {
    profileAId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },
    profileBId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    reason: { type: String, trim: true, default: 'duplicate_detected' },
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },

    status: { type: String, enum: ['open', 'accepted', 'rejected', 'merged'], default: 'open', index: true },

    createdBy: {
      adminId: { type: String, trim: true, default: null },
      email: { type: String, trim: true, lowercase: true, default: null },
      role: { type: String, trim: true, default: null },
    },
  },
  { timestamps: true }
);

ReporterMergeQueueSchema.index({ status: 1, createdAt: -1 });
ReporterMergeQueueSchema.index({ profileAId: 1, profileBId: 1 }, { unique: true });

module.exports = mongoose.models.ReporterMergeQueue || mongoose.model('ReporterMergeQueue', ReporterMergeQueueSchema);
