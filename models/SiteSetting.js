const mongoose = require('mongoose');

const SiteSettingSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['public'], required: true, index: true },
    key: { type: String, required: true, index: true },
    status: { type: String, enum: ['draft', 'published'], required: true, index: true },

    // Only set for published snapshots.
    version: { type: Number },

    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdBy: {
      id: { type: String },
      email: { type: String },
    },

    publishedBy: {
      id: { type: String },
      email: { type: String },
    },

    publishedAt: { type: Date },
  },
  { timestamps: true },
);

// Ensure only one draft per scope+key.
SiteSettingSchema.index({ scope: 1, key: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'draft' } });

// Ensure published versions are unique per scope+key.
SiteSettingSchema.index(
  { scope: 1, key: 1, status: 1, version: 1 },
  { unique: true, partialFilterExpression: { status: 'published' } },
);

module.exports = mongoose.models.SiteSetting || mongoose.model('SiteSetting', SiteSettingSchema);
