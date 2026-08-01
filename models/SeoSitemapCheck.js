const mongoose = require('mongoose');

const SitemapFileSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ['sitemap', 'news_sitemap', 'robots'], default: 'sitemap' },
    httpStatus: { type: Number, default: null },
    available: { type: Boolean, default: false },
    accessible: { type: Boolean, default: false },
    contentType: { type: String, default: null },
    checkedAt: { type: Date, default: null },
    urlCount: { type: Number, default: 0 },
    validCount: { type: Number, default: 0 },
    invalidCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    invalidEntries: { type: [String], default: [] },
    duplicateEntries: { type: [String], default: [] },
    nonCanonicalUrls: { type: [String], default: [] },
    urlsReturningErrors: { type: [mongoose.Schema.Types.Mixed], default: [] },
    noindexUrlsIncluded: { type: [String], default: [] },
    lastModified: { type: String, default: null },
    warnings: { type: [String], default: [] },
    errorMessage: { type: String, default: null },
  },
  { _id: false },
);

const SeoSitemapCheckSchema = new mongoose.Schema(
  {
    siteUrl: { type: String, required: true, index: true },
    status: { type: String, enum: ['completed', 'failed'], default: 'completed', index: true },
    checkedAt: { type: Date, required: true, index: true },
    checkedBy: { type: String, default: null },
    files: { type: [SitemapFileSchema], default: [] },
    warnings: { type: [String], default: [] },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: 'seo_sitemap_checks' },
);

SeoSitemapCheckSchema.index({ checkedAt: -1 });

module.exports = mongoose.models.SeoSitemapCheck || mongoose.model('SeoSitemapCheck', SeoSitemapCheckSchema);