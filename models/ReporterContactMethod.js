const mongoose = require('mongoose');

const TYPES = ['email', 'phone', 'whatsapp', 'telegram', 'instagram'];

const ReporterContactMethodSchema = new mongoose.Schema(
  {
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterProfile', required: true, index: true },

    type: { type: String, enum: TYPES, required: true, index: true },
    value: { type: String, trim: true, required: true },

    // Normalized for matching (email lowercased; phone digits only)
    normalized: { type: String, trim: true, default: null, index: true },

    isPrimary: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    source: { type: String, enum: ['self_reported', 'import', 'admin', 'system'], default: 'system' },

    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ReporterContactMethodSchema.index({ profileId: 1, type: 1, normalized: 1 });
ReporterContactMethodSchema.index({ type: 1, normalized: 1 });

module.exports = mongoose.models.ReporterContactMethod || mongoose.model('ReporterContactMethod', ReporterContactMethodSchema);
module.exports.TYPES = TYPES;
