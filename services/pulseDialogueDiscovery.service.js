const mongoose = require('mongoose');
const News = require('../models/News');
const Contributor = require('../models/Contributor');
const Series = require('../models/PulseDialogueSeries');
const { slugifyUnicode } = require('../lib/slug');
const { buildPubliclyVisibleNewsArticleFilter } = require('./publicArticleVisibility.service');
const { DIALOGUE_FORMAT_VALUES, attachPublicPulseDialogueContributorsBatch } = require('./pulseDialogue.service');
const { PUBLIC_FEED_SELECT, serializePublicNewsGroup } = require('../controllers/publicNewsController');

const QUERY_MS = 2500;
const FORMAT_GROUPS = Object.freeze({ columns: ['column', 'guest_column'], essays: ['essay', 'literary_essay'],
  culture: ['culture_ideas'], conversations: ['conversation', 'interview'] });

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function scalar(value, field, max) {
  if (typeof value !== 'string' || value.length > max) throw invalid(`Invalid ${field}`);
  return value.trim();
}

function slug(value, field) {
  const result = scalar(value, field, 140);
  if (!result || result !== value || result !== slugifyUnicode(result, { maxLength: 140 })) throw invalid(`Invalid ${field}`);
  return result;
}

function parseRequest(query = {}, { discovery = false } = {}) {
  const allowed = discovery ? ['lang'] : ['lang', 'page', 'limit', 'q', 'contributor', 'seriesSlug', 'dialogueFormat', 'sort'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw invalid('Unknown query parameter');
  const integer = (field, fallback, max) => {
    if (query[field] === undefined) return fallback;
    const text = scalar(query[field], field, 8);
    if (!/^[1-9]\d*$/.test(text) || Number(text) > max) throw invalid(`Invalid ${field}`);
    return Number(text);
  };
  const lang = query.lang === undefined ? 'gu' : scalar(query.lang, 'lang', 2);
  if (!['en', 'hi', 'gu'].includes(lang)) throw invalid('lang must be en, hi, or gu');
  const sort = query.sort === undefined ? 'newest' : scalar(query.sort, 'sort', 6);
  if (!['newest', 'oldest'].includes(sort)) throw invalid('sort must be newest or oldest');
  const formats = query.dialogueFormat === undefined ? [] : scalar(query.dialogueFormat, 'dialogueFormat', 200).split(',');
  if (formats.some(value => !DIALOGUE_FORMAT_VALUES.includes(value)) || new Set(formats).size !== formats.length) {
    throw invalid('Invalid dialogueFormat');
  }
  return { lang, sort, page: integer('page', 1, 1000), limit: integer('limit', 12, 24), formats,
    q: query.q === undefined ? '' : scalar(query.q, 'q', 80),
    contributor: query.contributor === undefined ? null : slug(query.contributor, 'contributor'),
    seriesSlug: query.seriesSlug === undefined ? null : slug(query.seriesSlug, 'seriesSlug') };
}

function publicFilter(association = {}) {
  const filter = buildPubliclyVisibleNewsArticleFilter();
  filter.category = 'pulse-dialogue';
  filter.$and.push(association);
  return filter;
}

async function requestFilter(options) {
  const filter = publicFilter();
  if (options.contributor) {
    const contributor = await Contributor.findOne({ slug: options.contributor, profileVisible: true,
      status: { $in: ['active', 'inactive'] } }).select('_id').maxTimeMS(QUERY_MS).lean();
    if (!contributor) throw invalid('Contributor is not publicly available');
    filter.$and.push({ 'pulseDialogue.contributorId': contributor._id });
  }
  if (options.seriesSlug) {
    const series = await Series.findOne({ slug: options.seriesSlug, profileVisible: true }).select('_id').maxTimeMS(QUERY_MS).lean();
    if (!series) throw invalid('Series is not publicly available');
    filter.$and.push({ 'pulseDialogue.seriesSlug': options.seriesSlug });
  }
  if (options.formats.length) filter.$and.push({ 'pulseDialogue.dialogueFormat': { $in: options.formats } });
  if (options.q) {
    const expression = new RegExp(options.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$and.push({ $or: ['title', 'summary', 'description'].map(field => ({ [field]: expression })) });
  }
  return filter;
}

const text = field => ({ $trim: { input: { $ifNull: [field, ''] } } });
const present = field => ({ $ne: [text(field), ''] });

function storyIdentity() {
  return { $switch: { branches: [
    ...['translationKey', 'translationGroupId'].map(field => ({ case: present(`$${field}`), then: { $concat: ['group:', text(`$${field}`)] } })),
    ...['slugs.en', 'slug', 'slugs.hi', 'slugs.gu'].map(field => ({ case: present(`$${field}`), then: { $concat: ['slug:', text(`$${field}`)] } })),
  ], default: { $concat: ['id:', { $toString: '$_id' }] } } };
}

function localeRank(lang) {
  const base = { $ifNull: ['$originalLang', { $ifNull: ['$lang', { $ifNull: ['$language', 'en'] }] }] };
  const stored = { $ifNull: ['$language', '$lang'] };
  const ready = { $and: [{ $eq: [`$translationStatus.${lang}`, 'ready'] },
    ...['title', 'summary', 'content'].map(field => present(`$translations.${lang}.${field}`))] };
  return { $switch: { branches: [
    { case: { $and: [{ $eq: [stored, lang] }, { $or: [{ $eq: [base, lang] }, ready] }] }, then: 4 },
    { case: { $eq: [base, lang] }, then: 3 }, { case: ready, then: 2 },
  ], default: 1 } };
}

function groupStages(sort = 'newest', lang = 'gu') {
  const direction = sort === 'oldest' ? 1 : -1;
  return [
    { $project: { _id: 1, translationKey: 1, translationGroupId: 1, slug: 1, slugs: 1, publishedAt: 1, createdAt: 1, _localeRank: localeRank(lang) } },
    { $sort: { _localeRank: -1, publishedAt: -1, createdAt: -1, _id: -1 } },
    { $group: { _id: storyIdentity(), publishedAt: { $first: '$publishedAt' }, createdAt: { $first: '$createdAt' }, sortId: { $first: '$_id' } } },
    { $sort: { publishedAt: direction, createdAt: direction, sortId: direction } },
  ];
}

function pagePipeline(filter, { page = 1, limit = 12, sort = 'newest', lang = 'gu' } = {}) {
  return [{ $match: filter }, ...groupStages(sort, lang), { $facet: {
    metadata: [{ $count: 'total' }], items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
  } }];
}

function aggregate(pipeline) {
  return News.aggregate(pipeline).option({ maxTimeMS: QUERY_MS, allowDiskUse: false }).exec();
}

function hydrationMatch(filter, keys) {
  const groupKeys = keys.filter(key => key.startsWith('group:')).map(key => key.slice(6));
  const slugs = keys.filter(key => key.startsWith('slug:')).map(key => key.slice(5));
  const ids = keys.filter(key => key.startsWith('id:')).map(key => new mongoose.Types.ObjectId(key.slice(3)));
  const clauses = [];
  if (groupKeys.length) clauses.push({ translationKey: { $in: groupKeys } }, { translationGroupId: { $in: groupKeys } });
  if (slugs.length) for (const field of ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu']) clauses.push({ [field]: { $in: slugs } });
  if (ids.length) clauses.push({ _id: { $in: ids } });
  return { $and: [filter, { $or: clauses }, { $expr: { $in: [storyIdentity(), keys] } }] };
}

function hydrationPipeline(filter, keys, lang, includeBody = false) {
  const projection = Object.fromEntries(PUBLIC_FEED_SELECT.split(' ').map(field => [field, 1]));
  if (!includeBody) projection.summary = 1;
  projection._storyKey = 1;
  if (!includeBody) {
    projection.content = { $cond: [present('$content'), 'available', ''] };
    projection.translations = Object.fromEntries(['en', 'hi', 'gu'].map(locale => [locale, {
      title: `$translations.${locale}.title`, summary: `$translations.${locale}.summary`,
      content: { $cond: [present(`$translations.${locale}.content`), 'available', ''] },
    }]));
  }
  return [{ $match: hydrationMatch(filter, keys) }, { $set: { _storyKey: storyIdentity(), _localeRank: localeRank(lang) } },
  { $sort: { _localeRank: -1, publishedAt: -1, createdAt: -1, _id: -1 } },
  { $group: { _id: '$_storyKey', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } },
  { $limit: keys.length }, { $project: projection }];
}

function compactCard(item) {
  const fields = ['id', '_id', 'articleId', 'title', 'summary', 'description', 'slug', 'slugs', 'canonicalSlug', 'category',
    'imageUrl', 'coverImageUrl', 'imageAlt', 'publishedAt', 'createdAt', 'language', 'lang', 'requestedLang', 'resolvedLang',
    'isTranslated', 'isFallback', 'translationKey', 'translationGroupId', 'canonicalDetailUrl', 'detailApiUrl', 'pulseDialogue', 'authorByline'];
  return Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]]));
}

async function hydrate(filter, groups, lang, { includeBody = false } = {}) {
  const keys = [...new Set(groups.map(group => group._id))];
  if (!keys.length) return [];
  const docs = await aggregate(hydrationPipeline(filter, keys, lang, includeBody));
  const byKey = new Map(docs.map(doc => [doc._storyKey, doc]));
  const items = keys.map(key => {
    const doc = byKey.get(key);
    if (!doc) return null;
    const item = serializePublicNewsGroup([doc], lang);
    if (item) delete item._storyKey;
    return item;
  }).filter(Boolean);
  await attachPublicPulseDialogueContributorsBatch(items, undefined, { queryMaxTimeMS: QUERY_MS });
  return includeBody ? items : items.map(compactCard);
}

async function listArticles(options, { filter, includeBody = false } = {}) {
  const match = filter || await requestFilter(options);
  const [result] = await aggregate(pagePipeline(match, options));
  const total = result?.metadata?.[0]?.total || 0;
  const items = await hydrate(match, result?.items || [], options.lang, { includeBody });
  return { items, lang: options.lang, total, count: items.length, page: options.page, limit: options.limit,
    totalPages: Math.ceil(total / options.limit), hasNextPage: options.page * options.limit < total };
}

async function countStories(filter) {
  const rows = await aggregate([{ $match: filter }, { $project: { translationKey: 1, translationGroupId: 1, slug: 1, slugs: 1 } },
    { $group: { _id: storyIdentity() } }, { $count: 'total' }]);
  return rows[0]?.total || 0;
}

module.exports = { QUERY_MS, FORMAT_GROUPS, invalid, slug, parseRequest, publicFilter, requestFilter, storyIdentity,
  groupStages, pagePipeline, hydrationPipeline, aggregate, hydrate, compactCard, listArticles, countStories };