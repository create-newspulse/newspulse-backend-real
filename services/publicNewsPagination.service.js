const News = require('../models/News');
const { buildPublicContentGroupExpression, getPublicContentGroupKey } = require('./publicCategoryListing.service');
const { timeAsync } = require('../lib/timingDiagnostics');

const QUERY_MS = 2500;
const COLLATION = Object.freeze({ locale: 'simple' });

class PublicNewsQueryError extends Error {
  constructor(field) {
    super(`Invalid ${field}`);
    this.statusCode = 400;
  }
}

function parsePublicNewsPagination(query) {
  const integer = (name, fallback) => {
    if (query[name] === undefined) return fallback;
    const value = query[name];
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) {
      throw new PublicNewsQueryError(name);
    }
    return Number(value);
  };
  const page = integer('page', 1);
  const limit = Math.min(integer('limit', 30), 100);
  if (!Number.isSafeInteger((page - 1) * limit + limit)) {
    throw new PublicNewsQueryError('page');
  }
  return { page, limit };
}

const string = value => ({ $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''] });
const text = value => ({ $trim: { input: string(value) } });
const present = value => ({ $ne: [text(value), ''] });
const regex = (input, pattern) => ({ $regexMatch: { input, regex: pattern } });

function normalizedLanguage(value) {
  return { $let: { vars: { raw: text(value) }, in: {
    $let: { vars: {
      lower: { $toLower: '$$raw' },
      letters: { $reduce: {
        input: { $regexFindAll: { input: { $toLower: '$$raw' }, regex: /[a-z]/ } },
        initialValue: '', in: { $concat: ['$$value', '$$this.match'] },
      } },
    }, in: { $switch: { branches: [
      { case: regex('$$raw', new RegExp('[\u0A80-\u0AFF]')), then: 'gu' },
      { case: regex('$$raw', new RegExp('[\u0900-\u097F]')), then: 'hi' },
      ...['en', 'hi', 'gu'].map(lang => ({
        case: regex('$$lower', new RegExp(`^${lang}(?:[-_]|$)`)), then: lang,
      })),
      { case: { $in: ['$$letters', ['english', 'eng']] }, then: 'en' },
      { case: { $in: ['$$letters', ['hindi', 'hin']] }, then: 'hi' },
      { case: { $in: ['$$letters', ['gujarati', 'gujrati', 'guj', 'gj']] }, then: 'gu' },
    ], default: null } } },
  } } };
}

function buildPublicNewsBaseLanguageExpression() {
  const content = string('$content');
  const plain = { $reduce: {
    input: { $regexFindAll: { input: content, regex: /<[^>]*>|([^<]+|<(?![^>]*>))/ } },
    initialValue: '',
    in: { $concat: ['$$value', { $ifNull: [{ $arrayElemAt: ['$$this.captures', 0] }, ' '] }] },
  } };
  const detected = { $switch: { branches: [
    { case: regex(content, new RegExp('[\u0A80-\u0AFF]')), then: 'gu' },
    { case: regex(content, new RegExp('[\u0900-\u097F]')), then: 'hi' },
  ], default: 'en' } };
  const inferred = { $let: { vars: {
    gu: { $size: { $regexFindAll: { input: plain, regex: new RegExp('[\u0A80-\u0AFF]') } } },
    hi: { $size: { $regexFindAll: { input: plain, regex: new RegExp('[\u0900-\u097F]') } } },
  }, in: { $switch: { branches: [
    { case: { $and: [{ $gte: ['$$gu', 12] }, { $gt: ['$$gu', '$$hi'] }] }, then: 'gu' },
    { case: { $and: [{ $gte: ['$$hi', 12] }, { $gt: ['$$hi', '$$gu'] }] }, then: 'hi' },
  ], default: { $ifNull: ['$$stored', detected] } } } } };
  // Keep the legacy originalLang/stored-language/script precedence of the public serializer.
  return { $let: { vars: {
    original: normalizedLanguage('$originalLang'),
    stored: normalizedLanguage({ $cond: [{ $ne: [string('$lang'), ''] }, '$lang', '$language'] }),
  }, in: { $ifNull: ['$$original', { $cond: [
    { $in: ['$$stored', ['hi', 'gu']] }, '$$stored', inferred,
  ] }] } } };
}

function buildPublicNewsPagePipeline(filter, { lang, page, limit }) {
  const nativeSummary = { $cond: [{ $ne: [string('$description'), ''] }, '$description', '$summary'] };
  return [
    { $match: filter },
    { $project: {
      _id: 1,
      storyKey: buildPublicContentGroupExpression(),
      publication: { $ifNull: ['$publishedAt', { $ifNull: ['$publishAt', { $ifNull: ['$createdAt', new Date(0)] }] }] },
      native: { $eq: [buildPublicNewsBaseLanguageExpression(), lang] },
      nativeComplete: { $and: [present('$title'), present(nativeSummary), present('$content')] },
      ready: { $and: [
        { $eq: [{ $toLower: text(`$translationStatus.${lang}`) }, 'ready'] },
        ...['title', 'summary', 'content'].map(field => present(`$translations.${lang}.${field}`)),
      ] },
    } },
    { $match: { $expr: { $cond: ['$native', '$nativeComplete', '$ready'] } } },
    { $sort: { native: -1, publication: -1, _id: -1 } },
    { $group: { _id: '$storyKey', articleId: { $first: '$_id' }, publication: { $first: '$publication' } } },
    { $sort: { publication: -1, articleId: -1 } },
    { $facet: {
      metadata: [{ $count: 'total' }],
      items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
    } },
  ];
}

async function listPublicNewsPage({ filter, lang, page, limit, select, timingContext, scope }) {
  const result = await timeAsync(`mongo.publicNews.${scope}.page`, timingContext, () => (
    News.aggregate(buildPublicNewsPagePipeline(filter, { lang, page, limit }))
      .option({ maxTimeMS: QUERY_MS, allowDiskUse: true, collation: COLLATION }).exec()
  ));
  const pageResult = result?.[0];
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(pageResult?.items)
      || !Array.isArray(pageResult?.metadata) || pageResult.metadata.length > 1) {
    throw new Error('Invalid public news pagination result');
  }
  const total = pageResult.metadata.length ? pageResult.metadata[0].total : 0;
  const expected = Math.max(0, Math.min(limit, total - (page - 1) * limit));
  if (!Number.isSafeInteger(total) || total < 0 || pageResult.items.length !== expected) {
    throw new Error('Inconsistent public news pagination result');
  }
  const ids = pageResult.items.map(item => item.articleId);
  let docs = [];
  if (ids.length) {
    const rows = await timeAsync(`mongo.publicNews.${scope}.hydrate`, timingContext, () => (
      News.find({ $and: [filter, { _id: { $in: ids } }] })
        .select(`${select} summary publishAt`).collation(COLLATION).limit(limit).maxTimeMS(QUERY_MS).lean()
    ));
    const byId = new Map(rows.map(doc => [String(doc._id), doc]));
    docs = ids.map(id => byId.get(String(id)));
    if (rows.length !== ids.length || docs.some(doc => !doc)) {
      throw new Error('Public news page changed during hydration');
    }
    if (docs.some((doc, index) => getPublicContentGroupKey(doc) !== pageResult.items[index]._id
        || new Date(doc.publishedAt ?? doc.publishAt ?? doc.createdAt ?? 0).getTime()
          !== new Date(pageResult.items[index].publication).getTime())) {
      throw new Error('Public news page identity or ordering changed during hydration');
    }
  }
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  return { docs, total, totalPages, hasMore: page < totalPages };
}

module.exports = {
  PublicNewsQueryError,
  parsePublicNewsPagination,
  buildPublicNewsBaseLanguageExpression,
  buildPublicNewsPagePipeline,
  listPublicNewsPage,
};
