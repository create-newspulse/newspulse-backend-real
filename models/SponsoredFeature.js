const mongoose = require('mongoose');

const {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  SPONSORED_FEATURE_TYPE,
  normalizePlacementKey,
  placementKeyToPlacement,
} = require('../lib/sponsoredFeatures');

const sponsoredFeatureSchema = new mongoose.Schema(
  {
    type: { type: String, default: SPONSORED_FEATURE_TYPE, trim: true, index: true },
    sponsorName: { type: String, required: true, trim: true },
    internalTitle: { type: String, required: true, trim: true },
    headline: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    ctaText: { type: String, required: true, trim: true },
    destinationUrl: { type: String, default: null, trim: true },
    coverImage: {
      url: { type: String, required: true, trim: true },
      publicId: { type: String, default: null, trim: true },
      alt: { type: String, default: null, trim: true },
    },
    isActive: { type: Boolean, default: false, index: true },
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },
    placementKey: {
      type: String,
      required: true,
      enum: SPONSORED_FEATURE_PLACEMENT_KEYS,
      index: true,
      set: normalizePlacementKey,
    },
    placement: { type: String, default: 'homepage_sponsored_feature', trim: true, index: true },
    labelText: { type: String, default: 'Sponsored Feature', trim: true },
    linkedArticleId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    linkedArticleUrl: { type: String, default: null, trim: true },
    comboCampaign: {
      isActive: { type: Boolean, default: true },
    },
    priority: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

sponsoredFeatureSchema.pre('validate', function preValidate(next) {
  try {
    this.type = SPONSORED_FEATURE_TYPE;
    this.placementKey = normalizePlacementKey(this.placementKey || this.placement) || this.placementKey;
    this.placement = placementKeyToPlacement(this.placementKey) || this.placement || 'homepage_sponsored_feature';
    if (!this.comboCampaign || typeof this.comboCampaign !== 'object') {
      this.comboCampaign = { isActive: true };
    }
    if (typeof this.comboCampaign.comboCampaignIsActive === 'boolean' && typeof this.comboCampaign.isActive !== 'boolean') {
      this.comboCampaign.isActive = this.comboCampaign.comboCampaignIsActive;
    }
  } catch (_) {}
  next();
});

sponsoredFeatureSchema.index(
  { placementKey: 1, isActive: 1, priority: -1, updatedAt: -1 },
  { name: 'placement_active_priority_updatedAt' }
);

module.exports = mongoose.models.SponsoredFeature || mongoose.model('SponsoredFeature', sponsoredFeatureSchema);