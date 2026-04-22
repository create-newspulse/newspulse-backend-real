const mongoose = require('mongoose');

const Article = require('../models/Article');
const {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  normalizePlacementKey,
  placementKeyToPlacement,
} = require('../lib/sponsoredFeatures');
const { buildPubliclyVisiblePublicArticleFilter } = require('../services/publicArticleVisibility.service');
const {
  getActiveSponsoredFeatureByPlacement,
  buildLinkedArticleDto,
  toPublicSponsoredFeatureDto,
} = require('../services/sponsoredFeatures.service');

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function articleCardFromDoc(doc, { labelText, selectedSource }) {
  if (!doc) return null;
  const linkedArticle = buildLinkedArticleDto(doc);
  return {
    kind: 'article',
    selectedSource,
    labelText,
    headline: doc.title || null,
    summary: doc.summary || null,
    ctaText: doc.isSponsored ? (doc.sponsorCtaText || 'Read More') : 'Read More',
    destinationUrl: linkedArticle && linkedArticle.apiUrl ? linkedArticle.apiUrl : null,
    effectiveDestinationUrl: linkedArticle && linkedArticle.apiUrl ? linkedArticle.apiUrl : null,
    imageUrl: linkedArticle ? linkedArticle.imageUrl : null,
    coverImage: doc.coverImage || null,
    article: linkedArticle,
    sponsor: doc.isSponsored === true
      ? {
          isSponsored: true,
          sponsorName: doc.sponsorName || null,
          sponsorLabel: doc.sponsorLabel || 'Sponsored',
          sponsorDisclosure: doc.sponsorDisclosure || null,
          sponsorCtaText: doc.sponsorCtaText || null,
          sponsorCtaUrl: doc.sponsorCtaUrl || null,
        }
      : null,
  };
}

function safeDefaultCard() {
  return {
    kind: 'default',
    selectedSource: 'safe-default',
    labelText: 'Top Story',
    headline: 'More stories coming soon',
    summary: 'Check back shortly for the latest NewsPulse updates.',
    ctaText: 'Refresh',
    destinationUrl: null,
    effectiveDestinationUrl: null,
    imageUrl: null,
    coverImage: null,
    article: null,
    sponsor: null,
  };
}

async function findEditorsPick(now, excludedIds = []) {
  const filter = buildPubliclyVisiblePublicArticleFilter({ now });
  filter.$and = (filter.$and || []).concat([
    { spotlightEnabled: true },
    { $or: [{ spotlightExpiresAt: null }, { spotlightExpiresAt: { $exists: false } }, { spotlightExpiresAt: { $gte: now } }] },
  ]);
  if (excludedIds.length) filter.$and.push({ _id: { $nin: excludedIds } });

  return Article.findOne(filter)
    .sort({ spotlightPinned: -1, spotlightPriority: -1, updatedAt: -1, publishedAt: -1 })
    .lean();
}

async function findTopExplainer(now, excludedIds = []) {
  const filter = buildPubliclyVisiblePublicArticleFilter({ now });
  filter.$and = (filter.$and || []).concat([
    {
      $or: [
        { category: 'editorial' },
        { tags: /^explainer$/i },
        { tags: /explainer/i },
      ],
    },
  ]);
  if (excludedIds.length) filter.$and.push({ _id: { $nin: excludedIds } });

  return Article.findOne(filter)
    .sort({ spotlightPriority: -1, publishedAt: -1, updatedAt: -1 })
    .lean();
}

async function findRegionalNationalFallback(now, excludedIds = []) {
  const baseFilter = buildPubliclyVisiblePublicArticleFilter({ now });
  baseFilter.$and = (baseFilter.$and || []).concat([{ category: { $in: ['regional', 'national'] } }]);
  if (excludedIds.length) baseFilter.$and.push({ _id: { $nin: excludedIds } });

  const strongFilter = {
    ...baseFilter,
    $and: [
      ...(baseFilter.$and || []),
      { title: { $exists: true, $nin: [null, ''] } },
      { summary: { $exists: true, $nin: [null, ''] } },
      { 'coverImage.url': { $exists: true, $nin: [null, ''] } },
    ],
  };

  const strong = await Article.findOne(strongFilter).sort({ publishedAt: -1, updatedAt: -1 }).lean();
  if (strong) return strong;
  return Article.findOne(baseFilter).sort({ publishedAt: -1, updatedAt: -1 }).lean();
}

async function getActiveSponsoredFeature(req, res) {
  res.set('Cache-Control', 'no-store, max-age=0');

  const placementRaw = (req.params && req.params.placementKey)
    || (req.query && (req.query.placementKey || req.query.placement))
    || SPONSORED_FEATURE_PLACEMENT_KEYS[0];
  const placementKey = normalizePlacementKey(placementRaw);
  if (!placementKey) {
    return res.status(400).json({ ok: false, message: `placementKey must be one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` });
  }

  if (!isDbReady()) {
    return res.status(200).json({ ok: true, placementKey, placement: placementKeyToPlacement(placementKey), feature: null });
  }

  const active = await getActiveSponsoredFeatureByPlacement(placementKey, { now: new Date() });
  return res.status(200).json({
    ok: true,
    placementKey,
    placement: placementKeyToPlacement(placementKey),
    feature: active ? toPublicSponsoredFeatureDto(active.feature, active.linkedArticle) : null,
  });
}

async function getHomepageCenterSlot(req, res) {
  res.set('Cache-Control', 'no-store, max-age=0');

  const now = new Date();
  if (!isDbReady()) {
    return res.status(200).json({
      ok: true,
      slotKey: 'HOMEPAGE_CENTER',
      selectedSource: 'safe-default',
      selectionOrder: ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default'],
      item: safeDefaultCard(),
    });
  }

  const excludedIds = [];
  const editorsPick = await findEditorsPick(now, excludedIds);
  if (editorsPick) {
    excludedIds.push(editorsPick._id);
    return res.status(200).json({
      ok: true,
      slotKey: 'HOMEPAGE_CENTER',
      selectedSource: 'editor-pick',
      selectionOrder: ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default'],
      item: articleCardFromDoc(editorsPick, { labelText: `Editor's Pick`, selectedSource: 'editor-pick' }),
    });
  }

  const topExplainer = await findTopExplainer(now, excludedIds);
  if (topExplainer) {
    excludedIds.push(topExplainer._id);
    return res.status(200).json({
      ok: true,
      slotKey: 'HOMEPAGE_CENTER',
      selectedSource: 'top-explainer',
      selectionOrder: ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default'],
      item: articleCardFromDoc(topExplainer, { labelText: 'Top Explainer', selectedSource: 'top-explainer' }),
    });
  }

  const fallbackArticle = await findRegionalNationalFallback(now, excludedIds);
  if (fallbackArticle) {
    return res.status(200).json({
      ok: true,
      slotKey: 'HOMEPAGE_CENTER',
      selectedSource: 'regional-national-fallback',
      selectionOrder: ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default'],
      item: articleCardFromDoc(fallbackArticle, { labelText: 'Top Story', selectedSource: 'regional-national-fallback' }),
    });
  }

  return res.status(200).json({
    ok: true,
    slotKey: 'HOMEPAGE_CENTER',
    selectedSource: 'safe-default',
    selectionOrder: ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default'],
    item: safeDefaultCard(),
  });
}

module.exports = {
  getActiveSponsoredFeature,
  getHomepageCenterSlot,
};