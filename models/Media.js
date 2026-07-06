const mongoose = require('mongoose');

const MediaSchema = new mongoose.Schema({
  storageId: { type: String, default: null, index: true },
  publicId: { type: String, default: null, index: true },
  provider: { type: String, default: 'local-disk', index: true },
  storageProvider: { type: String, default: null, index: true },
  source: { type: String, default: 'admin-media-library', index: true },
  status: { type: String, default: 'active', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  mediaType: { type: String, default: 'file', index: true },
  mimeType: { type: String, default: null },
  fileName: { type: String, default: null },
  filename: { type: String, default: null },
  originalName: { type: String, default: null },
  size: { type: Number, default: 0 },
  url: { type: String, default: null },
  assetUrl: { type: String, default: null },
  videoUrl: { type: String, default: null },
  posterUrl: { type: String, default: null },
  thumbnailUrl: { type: String, default: null },
  relativeUrl: { type: String, default: null },
  secureUrl: { type: String, default: null },
  title: { type: String, default: null },
  uploadedAt: { type: Date, default: null },
  isUsed: { type: Boolean, default: false, index: true },
  usageCount: { type: Number, default: 0, index: true },
  uploadedBy: {
    id: { type: String, default: null },
    email: { type: String, default: null },
    role: { type: String, default: null },
  },
  deletedAt: { type: Date, default: null },
  trashedAt: { type: Date, default: null, index: true },
  restoredAt: { type: Date, default: null },
}, {
  collection: 'media',
  timestamps: true,
});

MediaSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Media || mongoose.model('Media', MediaSchema);