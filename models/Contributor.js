const mongoose = require('mongoose');
const { slugifyUnicode, canonicalizeSlug } = require('../lib/slug');
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
  website: { type: String, default: null, trim: true },
  socialLinks: { type: Map, of: String, default: () => ({}) },
  status: { type: String, enum: CONTRIBUTOR_STATUS_VALUES, default: 'draft', index: true },
  internalEmail: { type: String, default: null, trim: true, lowercase: true },
  internalNotes: { type: String, default: null, trim: true },
  rightsConsent: { type: RightsConsentSchema, default: () => ({}) },
}, { timestamps: true });

ContributorSchema.pre('validate', function preValidate(next) {
  try {
    if (!this.slug && this.canonicalName) {
      this.slug = slugifyUnicode(this.canonicalName, { maxLength: 120 });
    }
    if (this.slug) this.slug = canonicalizeSlug(this.slug);
    return next();
  } catch (error) {
    return next(error);
  }
});

ContributorSchema.index({ canonicalName: 'text', publicDesignation: 'text', affiliation: 'text', shortBio: 'text' });

module.exports = mongoose.models.Contributor || mongoose.model('Contributor', ContributorSchema);