const mongoose = require('mongoose');

const ReporterBeatSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },
    beat: { type: String, trim: true, required: true, index: true },
    addedBy: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

ReporterBeatSchema.index({ profileId: 1, beat: 1 }, { unique: true });

module.exports = mongoose.models.ReporterBeat || mongoose.model('ReporterBeat', ReporterBeatSchema);
