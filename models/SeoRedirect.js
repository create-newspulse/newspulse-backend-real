const mongoose = require('mongoose');

const SeoRedirectSchema = new mongoose.Schema(
  {
    sourcePath: { type: String, required: true, trim: true, index: true },
    destinationUrl: { type: String, required: true, trim: true },
    statusCode: { type: Number, enum: [301, 302], default: 301 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { timestamps: true, collection: 'seo_redirects' },
);

SeoRedirectSchema.index({ sourcePath: 1, isActive: 1 });

module.exports = mongoose.models.SeoRedirect || mongoose.model('SeoRedirect', SeoRedirectSchema);