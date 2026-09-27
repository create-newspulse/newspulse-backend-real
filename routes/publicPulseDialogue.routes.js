const express = require('express');
const Contributor = require('../models/Contributor');
const Series = require('../models/PulseDialogueSeries');
const News = require('../models/News');
const { slugifyUnicode } = require('../lib/slug');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');
const {
  buildContributorProfileSummary,
  isContributorProfilePublic,
  normalizePulseDialogueLanguage,
} = require('../services/pulseDialogue.service');
const { resolveGroupedPublicNewsItems, resolvePublicNewsListRequest } = require('../controllers/publicNewsController');
const { getPublicContentGroupKey } = require('../services/publicCategoryListing.service');

const router = express.Router();
const contributorVisibility = { profileVisible: true, status: { $in: ['active', 'inactive'] } };
const contributorSelect = '_id slug canonicalName photo.url publicDesignation shortBio profileVisible status';

function pagination(query) {
  const bounded = (value, fallback, max) => {
    if (!/^\d+$/.test(String(value ?? ''))) return fallback;
    return Math.min(Math.max(Number(value), 1), max);
  };
  return { page: bounded(query.page, 1, 10000), limit: bounded(query.limit, 12, 50) };
}

function articleFilter(association) {
  const filter = buildPubliclyVisibleNewsArticleFilter();
  filter.$and.push({ category: 'pulse-dialogue' }, association);
  return filter;
}

function archiveLanguage(req) {
  const value = req.query.lang || req.query.language || req.headers['x-lang'] || req.headers['x-language'];
  if (value !== undefined && !normalizePulseDialogueLanguage(value)) {
    throw Object.assign(new Error('lang must be en, hi, or gu'), { statusCode: 400 });
  }
  return resolvePublicNewsListRequest(req).desired;
}

async function storyCount(filter) {
  const docs = await News.find(filter).select('_id translationKey translationGroupId slugs slug').lean();
  return new Set(docs.map(getPublicContentGroupKey)).size;
}

function validSlug(value) {
  return typeof value === 'string' && value.length <= 140 && value === slugifyUnicode(value, { maxLength: 140 });
}

function metadata(total, page, limit, count) {
  return { total, count, page, limit, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total };
}

function handle(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return await handler(req, res); }
    catch (error) {
      return res.status(error.statusCode === 400 ? 400 : 500).json({ ok: false,
        message: error.statusCode === 400 ? error.message : 'Unable to load Pulse Dialogue' });
    }
  };
}

function notFound(res) {
  return res.status(404).json({ ok: false, message: 'Not found' });
}

async function findContributor(slug) {
  if (!validSlug(slug)) return null;
  return Contributor.findOne({ $or: [{ slug }, { slugHistory: slug }], ...contributorVisibility }).select(contributorSelect).lean();
}

function contributorRedirectMetadata(requestedSlug, contributor) {
  return requestedSlug === contributor.slug ? {} : { requestedSlug, canonicalSlug: contributor.slug, redirectRequired: true };
}

async function seriesSummary(series) {
  let ownerContributor = null;
  if (series.ownerContributorId) {
    const owner = await Contributor.findOne({ _id: series.ownerContributorId, ...contributorVisibility }).select(contributorSelect).lean();
    if (isContributorProfilePublic(owner)) ownerContributor = buildContributorProfileSummary(owner);
  }
  return { slug: series.slug, title: series.title, description: series.description || null, ownerContributor };
}

async function archive(filter, req) {
  const { page, limit } = pagination(req.query);
  const lang = archiveLanguage(req);
  const { items, total } = await resolveGroupedPublicNewsItems({
    baseFilter: filter,
    categoryFilter: filter,
    requestedLang: lang,
    page,
    limit,
    sort: { publishedAt: -1, createdAt: -1, _id: -1 },
    categorySlug: 'pulse-dialogue',
    normalizedCategoryKey: 'pulse-dialogue',
  });
  return { items, lang, ...metadata(total, page, limit, items.length) };
}

router.get('/contributors', handle(async (req, res) => {
  const { page, limit } = pagination(req.query);
  const discoveryFilter = { profileVisible: true, status: 'active' };
  const [docs, total] = await Promise.all([
    Contributor.find(discoveryFilter).select(contributorSelect).sort({ canonicalName: 1, _id: 1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Contributor.countDocuments(discoveryFilter),
  ]);
  const items = docs.map(buildContributorProfileSummary);
  return res.json({ ok: true, items, ...metadata(total, page, limit, items.length) });
}));

router.get('/contributors/:slug', handle(async (req, res) => {
  const contributor = await findContributor(req.params.slug);
  if (!contributor) return notFound(res);
  archiveLanguage(req);
  const contributionCount = await storyCount(articleFilter({ 'pulseDialogue.contributorId': contributor._id }));
  return res.json({ ok: true, contributor: { ...buildContributorProfileSummary(contributor), contributionCount },
    ...contributorRedirectMetadata(req.params.slug, contributor) });
}));

router.get('/contributors/:slug/articles', handle(async (req, res) => {
  const contributor = await findContributor(req.params.slug);
  if (!contributor) return notFound(res);
  const result = await archive(articleFilter({ 'pulseDialogue.contributorId': contributor._id }), req);
  return res.json({ ok: true, contributor: { ...buildContributorProfileSummary(contributor), contributionCount: result.total }, ...result,
    ...contributorRedirectMetadata(req.params.slug, contributor) });
}));

router.get('/series', handle(async (req, res) => {
  const { page, limit } = pagination(req.query);
  const [docs, total] = await Promise.all([
    Series.find({ profileVisible: true }).select('slug title description').sort({ title: 1, _id: 1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Series.countDocuments({ profileVisible: true }),
  ]);
  const items = docs.map((series) => ({ slug: series.slug, title: series.title, description: series.description || null }));
  return res.json({ ok: true, items, ...metadata(total, page, limit, items.length) });
}));

async function getSeries(req, res, includeArticles) {
  if (!validSlug(req.params.slug)) return notFound(res);
  const series = await Series.findOne({ slug: req.params.slug, profileVisible: true })
    .select('slug title description ownerContributorId').lean();
  if (!series) return notFound(res);
  const filter = articleFilter({ 'pulseDialogue.seriesSlug': series.slug });
  archiveLanguage(req);
  const summary = await seriesSummary(series);
  if (!includeArticles) {
    return res.json({ ok: true, series: { ...summary, articleCount: await storyCount(filter) } });
  }
  const result = await archive(filter, req);
  return res.json({ ok: true, series: { ...summary, articleCount: result.total }, ...result });
}

router.get('/series/:slug', handle((req, res) => getSeries(req, res, false)));
router.get('/series/:slug/articles', handle((req, res) => getSeries(req, res, true)));

module.exports = router;