const mongoose = require('mongoose');

const ReporterActivityLogSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    type: {
      type: String,
      enum: ['note', 'contact_logged', 'task_created', 'task_completed', 'story_linked', 'status_change', 'verification_change', 'merge_suggested', 'merge_completed'],
      required: true,
      index: true,
    },

    message: { type: String, trim: true, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },

    actor: {
      kind: { type: String, enum: ['system', 'admin'], default: 'system' },
      adminId: { type: String, trim: true, default: null },
      email: { type: String, trim: true, lowercase: true, default: null },
      role: { type: String, trim: true, default: null },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ReporterActivityLogSchema.index({ profileId: 1, createdAt: -1 });

module.exports = mongoose.models.ReporterActivityLog || mongoose.model('ReporterActivityLog', ReporterActivityLogSchema);
