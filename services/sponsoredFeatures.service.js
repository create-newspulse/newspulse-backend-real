const mongoose = require('mongoose');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');
const { buildPubliclyVisiblePublicArticleFilter } = require('./publicArticleVisibility.service');
const {
  normalizePlacementKey,
  isItemInSchedule,
} = require('../lib/sponsoredFeatures');

const LINKED_ARTICLE_SELECT = [
  'title',
  'summary',
  'slug',
  'slugs',
  'sourceNewsId',
  'category',
  'language',
  'originalLang',
  'publishedAt',
  'updatedAt',
  'coverImage',
  'isSponsored',
  'sponsorName',
  'sponsorLabel',
  'sponsorDisclosure',
  'sponsorCtaText',
  'sponsorCtaUrl',
  'sponsorFeatureEligible',
  'sponsorFeatureLinkedId',
].join(' ');

function _coverImageUrl(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.coverImage && typeof doc.coverImage === 'object' && !Array.isArray(doc.coverImage)) {
    return doc.coverImage.url ? String(doc.coverImage.url) : null;
  }
  return null;
}

function _articleSlug(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.slug) return String(doc.slug);
  const lang = String(doc.language || doc.originalLang || 'en').trim().toLowerCase();
  if (doc.slugs && typeof doc.slugs === 'object' && doc.slugs[lang]) return String(doc.slugs[lang]);
  return null;
}

function buildLinkedArticleDto(doc) {
  if (!doc) return null;
  const slug = _articleSlug(doc);
  const articleId = String(doc._id || '');
  return {
    id: articleId || null,
    sourceNewsId: doc.sourceNewsId ? String(doc.sourceNewsId) : null,
    slug: slug || null,
    title: doc.title || null,
    summary: doc.summary || null,
    category: doc.category || null,
    language: doc.language || doc.originalLang || 'en',
    imageUrl: _coverImageUrl(doc),
    isSponsored: doc.isSponsored === true,
    sponsorName: doc.sponsorName || null,
    sponsorLabel: doc.sponsorLabel || (doc.isSponsored ? 'Sponsored' : null),
    sponsorDisclosure: doc.sponsorDisclosure || null,
    sponsorCtaText: doc.sponsorCtaText || null,
    sponsorCtaUrl: doc.sponsorCtaUrl || null,
    sponsorFeatureEligible: doc.sponsorFeatureEligible === true,
    sponsorFeatureLinkedId: doc.sponsorFeatureLinkedId ? String(doc.sponsorFeatureLinkedId) : null,
    publishedAt: doc.publishedAt || null,
    updatedAt: doc.updatedAt || null,
    apiUrl: slug ? `/api/public/news/${encodeURIComponent(slug)}` : (articleId ? `/api/public/news/${encodeURIComponent(articleId)}` : null),
  };
}

async function findLinkedArticleByAnyId(id, { publicOnly = true, now = new Date() } = {}) {
  const rawId = String(id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(rawId)) return null;

  const filter = publicOnly ? buildPubliclyVisiblePublicArticleFilter({ now }) : {};
  filter.$or = [{ _id: rawId }, { sourceNewsId: rawId }];

  return Article.findOne(filter).select(LINKED_ARTICLE_SELECT).lean();
}

function deriveEffectiveDestination(featureDoc, linkedArticle) {
  if (featureDoc && featureDoc.linkedArticleUrl) return String(featureDoc.linkedArticleUrl);
  if (featureDoc && featureDoc.destinationUrl) return String(featureDoc.destinationUrl);
  return linkedArticle && linkedArticle.apiUrl ? linkedArticle.apiUrl : null;
}

function toPublicSponsoredFeatureDto(featureDoc, linkedArticle) {
  if (!featureDoc) return null;
  const linkedArticleDto = linkedArticle ? buildLinkedArticleDto(linkedArticle) : null;
  return {
    id: String(featureDoc._id),
    sponsorName: featureDoc.sponsorName || null,
    internalTitle: featureDoc.internalTitle || null,
    headline: featureDoc.headline || null,
    summary: featureDoc.summary || null,
    ctaText: featureDoc.ctaText || null,
    destinationUrl: featureDoc.destinationUrl || null,
    effectiveDestinationUrl: deriveEffectiveDestination(featureDoc, linkedArticleDto),
    coverImage: featureDoc.coverImage || null,
    imageUrl: _coverImageUrl(featureDoc),
    isActive: featureDoc.isActive === true,
    startAt: featureDoc.startAt || null,
    endAt: featureDoc.endAt || null,
    placementKey: normalizePlacementKey(featureDoc.placementKey) || featureDoc.placementKey,
    labelText: featureDoc.labelText || 'Sponsored Feature',
    linkedArticleId: featureDoc.linkedArticleId ? String(featureDoc.linkedArticleId) : null,
    linkedArticleUrl: featureDoc.linkedArticleUrl || null,
    priority: typeof featureDoc.priority === 'number' ? featureDoc.priority : 0,
    updatedAt: featureDoc.updatedAt || null,
    linkedArticle: linkedArticleDto,
  };
}

async function getActiveSponsoredFeatureByPlacement(placementKey, { now = new Date() } = {}) {
  const normalizedPlacementKey = normalizePlacementKey(placementKey);
  if (!normalizedPlacementKey) return null;

  const candidates = await SponsoredFeature.find({
    placementKey: normalizedPlacementKey,
    isActive: true,
  })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(50)
    .lean();

  for (const candidate of candidates || []) {
    if (!isItemInSchedule(candidate, now)) continue;
    const linkedArticle = candidate.linkedArticleId
      ? await findLinkedArticleByAnyId(candidate.linkedArticleId, { publicOnly: true, now })
      : null;
    return {
      feature: candidate,
      linkedArticle,
    };
  }

  return null;
}

module.exports = {
  LINKED_ARTICLE_SELECT,
  buildLinkedArticleDto,
  findLinkedArticleByAnyId,
  deriveEffectiveDestination,
  toPublicSponsoredFeatureDto,
  getActiveSponsoredFeatureByPlacement,
};