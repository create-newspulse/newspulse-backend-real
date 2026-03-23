const mongoose = require('mongoose');

const ReporterStoryLinkSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunitySubmission', required: true, index: true },

    // Optional future linkage
    linkedArticleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null, index: true },

    reason: { type: String, trim: true, default: 'auto' },
    resolutionMethod: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

ReporterStoryLinkSchema.index({ profileId: 1, submissionId: 1 }, { unique: true });

module.exports = mongoose.models.ReporterStoryLink || mongoose.model('ReporterStoryLink', ReporterStoryLinkSchema);
