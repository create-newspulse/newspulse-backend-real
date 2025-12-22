const mongoose = require('mongoose');

const SystemSnapshotSchema = new mongoose.Schema(
  {
    label: { type: String, default: null, trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: String, default: null, trim: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false, collection: 'system_snapshots' },
);

SystemSnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.models.SystemSnapshot || mongoose.model('SystemSnapshot', SystemSnapshotSchema);
