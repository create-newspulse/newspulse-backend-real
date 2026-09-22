const mongoose = require('mongoose');

const Article = require('../models/Article');
const {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  normalizePlacementKey,
  placementKeyToPlacement,
} = require('../lib/sponsoredFeatures');
const { buildPubliclyVisiblePublicArticleFilter } = require('../services/publicArticleVisibility.service');
const { getSpotlightPriorityRank } = require('../services/spotlightPriority.service');
const {
  getActiveSponsoredFeatureByPlacement,
  buildLinkedArticleDto,
  toPublicSponsoredFeatureDto,
} = require('../services/sponsoredFeatures.service');

const SPOTLIGHT_STORY_LIMIT = 8;
const SPOTLIGHT_WINDOWS_HOURS = Object.freeze([24, 48, 72]);
const SPOTLIGHT_CATEGORY_LIMIT = 2;
const SPOTLIGHT_SELECT = [
  '_id',
  'title',
  'summary',
  'slug',
  'slugs',
  'sourceNewsId',
  'category',
  'language',
  'originalLang',
  'publishedAt',
  'createdAt',
  'updatedAt',
  'coverImage',
  'spotlightPriority',
  'spotlightExpiresAt',
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

function buildFreshSpotlightFilter(now, hours) {
  const nowDt = now instanceof Date ? now : new Date(now);
  const since = new Date(nowDt.getTime() - (Number(hours) * 60 * 60 * 1000));
  const filter = buildPubliclyVisiblePublicArticleFilter({ now: nowDt });
  filter.$and = (filter.$and || []).concat([
    { publishedAt: { $gte: since, $lte: nowDt } },
    { $or: [{ spotlightExpiresAt: null }, { spotlightExpiresAt: { $exists: false } }, { spotlightExpiresAt: { $gte: nowDt } }] },
  ]);
  return filter;
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function sortSpotlightCandidates(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const priorityDiff = getSpotlightPriorityRank(right && right.spotlightPriority) - getSpotlightPriorityRank(left && left.spotlightPriority);
    if (priorityDiff) return priorityDiff;

    const publishedDiff = dateMs(right && right.publishedAt) - dateMs(left && left.publishedAt);
    if (publishedDiff) return publishedDiff;

    const updatedDiff = dateMs(right && right.updatedAt) - dateMs(left && left.updatedAt);
    if (updatedDiff) return updatedDiff;

    return dateMs(right && right.createdAt) - dateMs(left && left.createdAt);
  });
}

function uniqueFreshCandidates(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item && item._id ? item._id : '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function selectCategoryBalancedSpotlight(items, limit = SPOTLIGHT_STORY_LIMIT) {
  const sorted = sortSpotlightCandidates(uniqueFreshCandidates(items));
  const selected = [];
  const selectedIds = new Set();
  const categoryCounts = new Map();

  for (const item of sorted) {
    if (selected.length >= limit) break;
    const category = String(item && item.category ? item.category : 'uncategorized').trim().toLowerCase() || 'uncategorized';
    const count = categoryCounts.get(category) || 0;
    if (count >= SPOTLIGHT_CATEGORY_LIMIT) continue;

    selected.push(item);
    selectedIds.add(String(item._id));
    categoryCounts.set(category, count + 1);
  }

  for (const item of sorted) {
    if (selected.length >= limit) break;
    const id = String(item && item._id ? item._id : '');
    if (!id || selectedIds.has(id)) continue;
    selected.push(item);
    selectedIds.add(id);
  }

  return selected;
}

async function findFreshSpotlightStories(now) {
  let candidates = [];

  for (const hours of SPOTLIGHT_WINDOWS_HOURS) {
    const filter = buildFreshSpotlightFilter(now, hours);
    const docs = await Article.find(filter)
      .select(SPOTLIGHT_SELECT)
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();
    candidates = uniqueFreshCandidates(docs);
    if (candidates.length >= SPOTLIGHT_STORY_LIMIT || hours === SPOTLIGHT_WINDOWS_HOURS[SPOTLIGHT_WINDOWS_HOURS.length - 1]) break;
  }

  return selectCategoryBalancedSpotlight(candidates, SPOTLIGHT_STORY_LIMIT);
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

  const spotlightStories = await findFreshSpotlightStories(now);
  if (spotlightStories.length) {
    const items = spotlightStories.map((doc) => articleCardFromDoc(doc, { labelText: 'Spotlight', selectedSource: 'spotlight' }));
    return res.status(200).json({
      ok: true,
      slotKey: 'HOMEPAGE_CENTER',
      selectedSource: 'spotlight',
      selectionOrder: ['spotlight', 'safe-default'],
      item: items[0],
      items,
    });
  }

  return res.status(200).json({
    ok: true,
    slotKey: 'HOMEPAGE_CENTER',
    selectedSource: 'safe-default',
    selectionOrder: ['spotlight', 'safe-default'],
    item: safeDefaultCard(),
    items: [],
  });
}

module.exports = {
  getActiveSponsoredFeature,
  getHomepageCenterSlot,
  _private: {
    buildFreshSpotlightFilter,
    selectCategoryBalancedSpotlight,
    sortSpotlightCandidates,
  },
};