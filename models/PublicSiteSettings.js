const mongoose = require('mongoose');

const PublicSiteSettingsSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['public'], required: true, unique: true, index: true },
    draft: { type: mongoose.Schema.Types.Mixed, default: {} },
    published: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'public_site_settings' },
);

module.exports = mongoose.models.PublicSiteSettings || mongoose.model('PublicSiteSettings', PublicSiteSettingsSchema);
