const mongoose = require('mongoose');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');
const { buildPubliclyVisiblePublicArticleFilter } = require('./publicArticleVisibility.service');
const {
  normalizePlacementKey,
  isItemInSchedule,
  SPONSORED_FEATURE_TYPE,
  placementKeyToPlacement,
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
  'isSponsoredArticle',
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
  const isSponsoredArticle = doc.isSponsoredArticle === true || doc.isSponsored === true;
  const path = slug ? `/news/${encodeURIComponent(slug)}` : null;
  return {
    id: articleId || null,
    sourceNewsId: doc.sourceNewsId ? String(doc.sourceNewsId) : null,
    slug: slug || null,
    path,
    title: doc.title || null,
    summary: doc.summary || null,
    category: doc.category || null,
    language: doc.language || doc.originalLang || 'en',
    imageUrl: _coverImageUrl(doc),
    isSponsored: doc.isSponsored === true || isSponsoredArticle,
    isSponsoredArticle,
    sponsorName: doc.sponsorName || null,
    sponsorLabel: doc.sponsorLabel || (isSponsoredArticle ? 'Sponsored' : null),
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

function isSponsoredArticleDoc(doc) {
  return !!(doc && (doc.isSponsoredArticle === true || doc.isSponsored === true));
}

function deriveEffectiveDestination(featureDoc, linkedArticle) {
  if (linkedArticle && linkedArticle.path) return linkedArticle.path;
  if (featureDoc && featureDoc.destinationUrl) return String(featureDoc.destinationUrl);
  if (featureDoc && featureDoc.linkedArticleUrl) return String(featureDoc.linkedArticleUrl);
  return null;
}

function buildActiveSponsoredFeatureFilter(placementKey) {
  const normalizedPlacementKey = normalizePlacementKey(placementKey);
  const placement = normalizedPlacementKey ? placementKeyToPlacement(normalizedPlacementKey) : null;
  if (!normalizedPlacementKey) return null;

  return {
    isActive: true,
    $or: [
      { placementKey: normalizedPlacementKey },
      ...(placement ? [{ placement }] : []),
    ],
  };
}

function toPublicSponsoredFeatureDto(featureDoc, linkedArticle) {
  if (!featureDoc) return null;
  const linkedArticleDto = linkedArticle ? buildLinkedArticleDto(linkedArticle) : null;
  const targetUrl = deriveEffectiveDestination(featureDoc, linkedArticleDto);
  return {
    label: featureDoc.labelText || 'Sponsored Feature',
    sponsorName: featureDoc.sponsorName || null,
    headline: featureDoc.headline || null,
    summary: featureDoc.summary || null,
    ctaText: featureDoc.ctaText || null,
    coverImage: featureDoc.coverImage || null,
    targetType: linkedArticleDto && linkedArticleDto.path ? 'linked_article' : (targetUrl ? 'external_url' : null),
    targetUrl,
    linkedArticle: linkedArticleDto
      ? {
          slug: linkedArticleDto.slug || null,
          path: linkedArticleDto.path || null,
        }
      : null,
  };
}

async function getActiveSponsoredFeatureByPlacement(placementKey, { now = new Date() } = {}) {
  const filter = buildActiveSponsoredFeatureFilter(placementKey);
  if (!filter) return null;

  const candidates = await SponsoredFeature.find(filter)
    .sort({ priority: -1, updatedAt: -1 })
    .limit(50)
    .lean();

  for (const candidate of candidates || []) {
    if (!isItemInSchedule(candidate, now)) continue;
    const linkedArticleDoc = candidate.linkedArticleId
      ? await findLinkedArticleByAnyId(candidate.linkedArticleId, { publicOnly: true, now })
      : null;
    const linkedArticle = isSponsoredArticleDoc(linkedArticleDoc) ? linkedArticleDoc : null;
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
  buildActiveSponsoredFeatureFilter,
  findLinkedArticleByAnyId,
  isSponsoredArticleDoc,
  deriveEffectiveDestination,
  toPublicSponsoredFeatureDto,
  getActiveSponsoredFeatureByPlacement,
};