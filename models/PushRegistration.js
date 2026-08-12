const mongoose = require('mongoose');

const PREFERENCE_KEYS = Object.freeze([
  'breakingNews',
  'topStories',
  'newArticleAlerts',
  'categoryAlerts',
  'allArticles',
]);

const DEFAULT_PUSH_PREFERENCES = Object.freeze({
  breakingNews: true,
  topStories: true,
  newArticleAlerts: true,
  categoryAlerts: true,
  allArticles: false,
});

const preferenceSchema = new mongoose.Schema({
  breakingNews: { type: Boolean, default: true },
  topStories: { type: Boolean, default: true },
  newArticleAlerts: { type: Boolean, default: true },
  categoryAlerts: { type: Boolean, default: true },
  allArticles: { type: Boolean, default: false },
}, { _id: false });

const pushRegistrationSchema = new mongoose.Schema({
  registrationId: { type: String, required: true, trim: true, select: false },
  registrationType: { type: String, enum: ['fid', 'token'], required: true, index: true },
  platform: { type: String, enum: ['web', 'android', 'ios'], default: 'web', index: true },
  enabled: { type: Boolean, default: true, index: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  preferences: { type: preferenceSchema, default: () => ({ ...DEFAULT_PUSH_PREFERENCES }) },
  categories: { type: [String], default: [], index: true },
  language: { type: String, enum: ['en', 'hi', 'gu'], default: 'en', index: true },
  firebaseProjectId: { type: String, default: null, trim: true, index: true },
  lastRegisteredAt: { type: Date, default: Date.now, index: true },
  disabledAt: { type: Date, default: null },
  lastSuccessfulSendAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  lastFailureCode: { type: String, default: null, trim: true },
  lastFailureReason: { type: String, default: null, trim: true },
}, { timestamps: true });

pushRegistrationSchema.index({ registrationType: 1, registrationId: 1 }, { unique: true });
pushRegistrationSchema.index({ enabled: 1, status: 1, language: 1, updatedAt: -1 });
pushRegistrationSchema.index({ enabled: 1, status: 1, categories: 1, updatedAt: -1 });

module.exports = mongoose.models.PushRegistration || mongoose.model('PushRegistration', pushRegistrationSchema);
module.exports.PREFERENCE_KEYS = PREFERENCE_KEYS;
module.exports.DEFAULT_PUSH_PREFERENCES = DEFAULT_PUSH_PREFERENCES;