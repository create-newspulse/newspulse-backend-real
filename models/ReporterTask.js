const mongoose = require('mongoose');

const ReporterTaskSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    title: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: null },

    status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open', index: true },

    dueAt: { type: Date, default: null, index: true },
    nextFollowUpAt: { type: Date, default: null, index: true },

    assignedTo: { type: String, trim: true, default: null, index: true },
    labels: { type: [String], default: [], index: true },

    archived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ReporterTaskSchema.index({ profileId: 1, status: 1, archived: 1 });

module.exports = mongoose.models.ReporterTask || mongoose.model('ReporterTask', ReporterTaskSchema);
