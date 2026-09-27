const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');
const { isProductionLike } = require('../lib/environmentSafety');
const { normalizeContributorSlug, normalizeContributorSlugHistory } = require('../lib/contributorSlugHistory');
const {
  CONTRIBUTOR_STATUS_VALUES,
  CONTRIBUTOR_TYPE_VALUES,
} = require('../services/pulseDialogue.service');

const PhotoSchema = new mongoose.Schema({
  url: { type: String, default: null, trim: true },
  publicId: { type: String, default: null, trim: true },
  alt: { type: String, default: null, trim: true },
}, { _id: false });

const RightsConsentSchema = new mongoose.Schema({
  publicationRightsConfirmed: { type: Boolean, default: false },
  profileConsentConfirmed: { type: Boolean, default: false },
  photoUsagePermissionConfirmed: { type: Boolean, default: false },
  disclosureReviewed: { type: Boolean, default: false },
  notes: { type: String, default: null, trim: true },
}, { _id: false });

const ContributorSchema = new mongoose.Schema({
  canonicalName: { type: String, required: true, trim: true, index: true },
  displayNameHi: { type: String, default: null, trim: true },
  displayNameGu: { type: String, default: null, trim: true },
  photo: { type: PhotoSchema, default: null },
  publicDesignation: { type: String, default: null, trim: true },
  contributorType: { type: String, enum: CONTRIBUTOR_TYPE_VALUES, default: 'guest_contributor', index: true },
  affiliation: { type: String, default: null, trim: true },
  shortBio: { type: String, default: null, trim: true },
  location: { type: String, default: null, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
  slugHistory: { type: [String], default: undefined, set: value => value === undefined ? undefined : normalizeContributorSlugHistory(value) },
  website: { type: String, default: null, trim: true },
  socialLinks: { type: Map, of: String, default: () => ({}) },
  status: { type: String, enum: CONTRIBUTOR_STATUS_VALUES, default: 'draft', index: true },
  profileVisible: { type: Boolean, default: false },
  internalEmail: { type: String, default: null, trim: true, lowercase: true },
  internalNotes: { type: String, default: null, trim: true },
  rightsConsent: { type: RightsConsentSchema, default: () => ({}) },
}, { timestamps: true, ...(isProductionLike() ? { autoIndex: false, autoCreate: false } : {}) });

ContributorSchema.post('init', function rememberCanonicalSlug(doc) {
  doc.$locals.originalSlug = doc.slug;
});

ContributorSchema.post('save', function rememberSavedSlug(doc) {
  doc.$locals.originalSlug = doc.slug;
});

ContributorSchema.pre('validate', function preValidate(next) {
  try {
    if (!this.slug && this.canonicalName) {
      this.slug = slugifyUnicode(this.canonicalName, { maxLength: 120 });
    }
    if (this.slug) this.slug = normalizeContributorSlug(this.slug);
    if (this.slug) this.slugHistory = normalizeContributorSlugHistory([...(this.slugHistory || []), this.$locals.originalSlug], this.slug);
    return next();
  } catch (error) {
    return next(error);
  }
});

ContributorSchema.index({ canonicalName: 'text', publicDesignation: 'text', affiliation: 'text', shortBio: 'text' });
ContributorSchema.index({ slugHistory: 1 }, { unique: true, partialFilterExpression: { 'slugHistory.0': { $exists: true } } });

module.exports = mongoose.models.Contributor || mongoose.model('Contributor', ContributorSchema);