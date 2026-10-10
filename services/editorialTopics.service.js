const mongoose = require('mongoose');
const { z } = require('zod');
const EditorialTopic = require('../models/EditorialTopic');
const News = require('../models/News');
const { buildPubliclyVisibleNewsArticleFilter } = require('./publicArticleVisibility.service');
const { buildPublicContentGroupExpression, getPublicContentGroupKey } = require('./publicCategoryListing.service');
const { localizeArticleForLang, SUPPORTED_LANGS } = require('./mapArticleForLang');

const { LIMITS, isCanonicalTopicSlug, isExactTopicTag } = EditorialTopic;
const QUERY_MS = 2500;
const COLLATION = { locale: 'simple' };
const TOPIC_PUBLIC_SELECT = '_id slug name description order startsAt expiresAt';
const STORY_SELECT = '_id title summary description content slug slugs category lang language originalLang '
  + 'translationKey translationGroupId sourceArticleId translations translationStatus publishedAt '
  + 'coverImage.url coverImage.alt coverImageUrl imageURL imageUrl';

const localized = (max, required) => z.object(Object.fromEntries(SUPPORTED_LANGS.map(lang => [
  lang, required ? z.string().trim().min(1).max(max) : z.string().trim().max(max).optional(),
]))).strict();
const dateInput = z.string().datetime({ offset: true }).transform(value => new Date(value));
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const editable = {
  name: localized(LIMITS.name, true),
  description: localized(LIMITS.description, false),
  active: z.boolean(),
  order: z.number().int().safe(),
  startsAt: dateInput,
  expiresAt: dateInput.nullable(),
  articleTags: z.array(z.string().trim().refine(isExactTopicTag)).min(1).max(LIMITS.tags)
    .transform(values => [...new Set(values)]),
  pinnedArticleId: objectId.nullable(),
};
const createInput = z.object({
  ...editable,
  slug: z.string().transform(value => value.normalize('NFKC').trim().toLowerCase()).refine(isCanonicalTopicSlug),
  description: editable.description.optional(),
  active: editable.active.default(false),
  order: editable.order.default(0),
  expiresAt: editable.expiresAt.default(null),
  pinnedArticleId: editable.pinnedArticleId.default(null),
}).strict();
const patchInput = z.object({ ...editable, name: editable.name.partial() }).partial().strict()
  .refine(value => Object.keys(value).length > 0);

class TopicError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function invalid(message = 'Invalid topic input') {
  return new TopicError(400, 'INVALID_INPUT', message);
}

function unavailable() {
  return new TopicError(503, 'TOPICS_UNAVAILABLE', 'Editorial topics are temporarily unavailable');
}

function handleTopicRequest(handler) {
  return async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) throw unavailable();
      return await handler(req, res);
    } catch (error) {
      let failure = error;
      if (error instanceof z.ZodError || ['ValidationError', 'CastError'].includes(error?.name)) failure = invalid();
      else if (error?.code === 11000) failure = new TopicError(409, 'SLUG_CONFLICT', 'Topic slug already exists');
      else if (error?.name === 'VersionError') failure = new TopicError(409, 'EDIT_CONFLICT', 'Topic changed; reload before editing');
      else if (mongoose.connection.readyState !== 1 || error?.code === 50
        || ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError',
          'MongooseServerSelectionError', 'MongoNotConnectedError'].includes(error?.name)) failure = unavailable();
      if (!(failure instanceof TopicError)) {
        console.error('[editorial-topics] Unexpected request failure');
        failure = new TopicError(500, 'INTERNAL_ERROR', 'Unable to process editorial topics');
      } else if (failure.statusCode === 503) {
        console.error('[editorial-topics] Database unavailable or query deadline exceeded');
      }
      return res.status(failure.statusCode).json({ ok: false, code: failure.code, message: failure.message });
    }
  };
}

function parseQuery(query, kind) {
  const allowed = kind === 'admin' ? ['active', 'page', 'limit']
    : kind === 'stories' ? ['lang', 'page', 'limit'] : kind === 'strip' ? ['lang', 'limit'] : ['lang'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw invalid('Unknown query parameter');
  const integer = (key, fallback, max) => {
    if (query[key] === undefined) return fallback;
    const value = query[key];
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))
        || Number(value) > max) throw invalid(`Invalid ${key}`);
    return Number(value);
  };
  const lang = query.lang === undefined ? 'gu' : query.lang;
  if (!SUPPORTED_LANGS.includes(lang)) throw invalid('lang must be gu, hi, or en');
  const active = query.active === undefined ? 'all' : query.active;
  if (!['all', 'true', 'false'].includes(active)) throw invalid('active must be all, true, or false');
  return { lang, active, page: integer('page', 1, 10000), limit: integer('limit', kind === 'admin' ? 20 : 12, kind === 'admin' ? 100 : 50) };
}

function pagination(total, page, limit, count) {
  return { total, count, page, limit, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total };
}

function publicTopic(doc, lang) {
  return {
    id: String(doc._id), key: doc.slug, slug: doc.slug, label: doc.name[lang],
    href: `/topic/${doc.slug}`, colorKey: 'blue',
    name: Object.fromEntries(SUPPORTED_LANGS.map(locale => [locale, doc.name[locale]])),
    description: Object.fromEntries(SUPPORTED_LANGS.map(locale => [locale, doc.description?.[locale] || ''])),
    order: doc.order, startsAt: doc.startsAt, expiresAt: doc.expiresAt || null,
  };
}

function adminTopic(value) {
  const doc = typeof value.toObject === 'function' ? value.toObject() : value;
  return { ...publicTopic(doc, 'gu'), active: doc.active, articleTags: doc.articleTags,
    pinnedArticleId: doc.pinnedArticleId ? String(doc.pinnedArticleId) : null,
    createdBy: doc.createdBy, updatedBy: doc.updatedBy, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
}

async function listPublicTopics(query, now = new Date()) {
  const { lang, limit } = parseQuery(query, 'strip');
  const items = await EditorialTopic.find({ active: true, startsAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] })
    .select(TOPIC_PUBLIC_SELECT).sort({ order: 1, _id: 1 }).limit(limit).maxTimeMS(QUERY_MS).lean();
  return { lang, items: items.map(doc => publicTopic(doc, lang)) };
}

async function findPublicTopic(slug, now) {
  if (!isCanonicalTopicSlug(slug)) throw new TopicError(404, 'TOPIC_NOT_FOUND', 'Topic not found');
  const topic = await EditorialTopic.findOne({ slug, active: true, startsAt: { $lte: now } })
    .select(`${TOPIC_PUBLIC_SELECT} articleTags pinnedArticleId`).maxTimeMS(QUERY_MS).lean();
  if (!topic) throw new TopicError(404, 'TOPIC_NOT_FOUND', 'Topic not found');
  return topic;
}

function storyFilter(topic, now) {
  if (!Array.isArray(topic.articleTags) || !topic.articleTags.length || !topic.articleTags.every(isExactTopicTag)) {
    throw new Error('Invalid persisted topic association');
  }
  const filter = buildPubliclyVisibleNewsArticleFilter({ now });
  filter.$and.push({ tags: { $in: topic.articleTags } }, { visibility: { $not: /^private$/i } });
  return filter;
}

const string = value => ({ $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''] });
const trimmed = value => ({ $trim: { input: string(value) } });
const present = value => ({ $ne: [trimmed(value), ''] });

// Match the shared mapper's locale normalization before database pagination.
function languageExpression(value) {
  return { $let: { vars: { raw: { $toLower: trimmed(value) } }, in: {
    $let: { vars: { letters: { $reduce: {
      input: { $regexFindAll: { input: '$$raw', regex: /[a-z]/ } }, initialValue: '',
      in: { $concat: ['$$value', '$$this.match'] },
    } } }, in: { $switch: { branches: [
      { case: { $in: ['$$letters', ['english', 'eng']] }, then: 'en' },
      { case: { $in: ['$$letters', ['hindi', 'hin']] }, then: 'hi' },
      { case: { $in: ['$$letters', ['gujarati', 'gujrati', 'guj', 'gj']] }, then: 'gu' },
      ...SUPPORTED_LANGS.map(lang => ({ case: { $regexMatch: { input: '$$raw', regex: new RegExp(`^${lang}(?:[-_]|$)`) } }, then: lang })),
    ], default: null } } },
  } } };
}

function storyPagePipeline(filter, { lang, page, limit }) {
  const base = { $ifNull: [languageExpression('$originalLang'),
    languageExpression({ $cond: [{ $ne: [string('$lang'), ''] }, '$lang', '$language'] }), 'en'] };
  return [
    { $match: filter },
    { $project: {
      _id: 1, publishedAt: 1, storyKey: buildPublicContentGroupExpression(),
      native: { $eq: [base, lang] },
      ready: { $and: [{ $eq: [{ $toLower: trimmed(`$translationStatus.${lang}`) }, 'ready'] },
        ...['title', 'summary', 'content'].map(field => present(`$translations.${lang}.${field}`))] },
      sourcePublication: { $cond: [
        { $or: [{ $eq: [{ $ifNull: ['$sourceArticleId', null] }, null] }, { $eq: ['$sourceArticleId', '$_id'] }] },
        '$publishedAt', null,
      ] },
    } },
    { $set: { eligible: { $or: ['$native', '$ready'] } } },
    { $sort: { eligible: -1, native: -1, publishedAt: -1, _id: -1 } },
    { $group: {
      _id: '$storyKey', articleId: { $first: '$_id' }, eligible: { $first: '$eligible' },
      originalPublication: { $min: '$sourcePublication' }, earliestPublication: { $min: '$publishedAt' },
    } },
    { $match: { eligible: true } },
    { $project: { articleId: 1, publication: { $ifNull: ['$originalPublication', '$earliestPublication', null] } } },
    { $sort: { publication: -1, _id: 1 } },
    { $facet: { metadata: [{ $count: 'total' }], items: [{ $skip: (page - 1) * limit }, { $limit: limit }] } },
  ];
}

function storyCard(doc, lang, publication) {
  const localized = localizeArticleForLang(doc, lang, { fallbackToBase: false, allowMissingStatus: false });
  if (!localized || localized.resolvedLang !== lang) throw unavailable();
  const imageUrl = doc.coverImage?.url || doc.coverImageUrl || doc.imageURL || doc.imageUrl || null;
  return {
    id: String(doc._id), _id: String(doc._id), articleId: String(doc._id),
    slug: localized.slug, canonicalSlug: localized.canonicalSlug,
    title: localized.title, summary: localized.summary, description: localized.summary,
    category: doc.category, lang, language: lang, requestedLang: lang, resolvedLang: lang,
    isTranslated: localized.isTranslated, isFallback: false,
    translationKey: doc.translationKey || null, translationGroupId: doc.translationGroupId || null,
    publishedAt: publication == null ? null : new Date(publication),
    imageUrl, coverImageUrl: imageUrl, imageAlt: doc.coverImage?.alt || null,
  };
}

async function readStoryPage(filter, options) {
  const result = await News.aggregate(storyPagePipeline(filter, options))
    .option({ maxTimeMS: QUERY_MS, allowDiskUse: false, collation: COLLATION }).exec();
  const page = result?.[0];
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(page?.items)
      || !Array.isArray(page?.metadata) || page.metadata.length > 1) throw new Error('Invalid story page');
  const total = page.metadata.length ? page.metadata[0].total : 0;
  const expected = Math.max(0, Math.min(options.limit, total - (options.page - 1) * options.limit));
  if (!Number.isSafeInteger(total) || total < 0 || page.items.length !== expected) throw new Error('Invalid story totals');
  let items = [];
  if (page.items.length) {
    const ids = page.items.map(item => item.articleId);
    const docs = await News.find({ $and: [filter, { _id: { $in: ids } }] })
      .select(STORY_SELECT).collation(COLLATION).limit(options.limit).maxTimeMS(QUERY_MS).lean();
    const byId = new Map(docs.map(doc => [String(doc._id), doc]));
    items = page.items.map(group => {
      const doc = byId.get(String(group.articleId));
      if (!doc || getPublicContentGroupKey(doc) !== group._id) throw unavailable();
      return storyCard(doc, options.lang, group.publication);
    });
  }
  return { items, ...pagination(total, options.page, options.limit, items.length) };
}

async function resolvePin(topic, lang, now) {
  if (!topic.pinnedArticleId) return null;
  const filter = storyFilter(topic, now);
  const anchor = await News.findOne({ $and: [filter, { _id: topic.pinnedArticleId }] })
    .select('_id translationKey translationGroupId slug slugs').collation(COLLATION).maxTimeMS(QUERY_MS).lean();
  if (!anchor) return null;
  const key = getPublicContentGroupKey(anchor);
  filter.$and.push({ $expr: { $eq: [buildPublicContentGroupExpression(), key] } });
  const page = await readStoryPage(filter, { lang, page: 1, limit: 1 });
  return page.items.length ? { key, article: page.items[0] } : null;
}

async function getPublicTopic(slug, query, now = new Date()) {
  const { lang } = parseQuery(query, 'detail');
  const topic = await findPublicTopic(slug, now);
  const pin = await resolvePin(topic, lang, now);
  return { lang, topic: publicTopic(topic, lang), pinnedArticle: pin?.article || null };
}

async function listTopicStories(slug, query, now = new Date()) {
  const options = parseQuery(query, 'stories');
  const topic = await findPublicTopic(slug, now);
  const pin = await resolvePin(topic, options.lang, now);
  const filter = storyFilter(topic, now);
  if (pin) filter.$and.push({ $expr: { $ne: [buildPublicContentGroupExpression(), pin.key] } });
  return { lang: options.lang, ...await readStoryPage(filter, options) };
}

function parseId(value) {
  return new mongoose.Types.ObjectId(objectId.parse(value));
}

async function validatePin(topic, now) {
  if (!topic.pinnedArticleId) return;
  const found = await News.findOne({ $and: [storyFilter(topic, now), { _id: topic.pinnedArticleId }] })
    .select('_id').collation(COLLATION).maxTimeMS(QUERY_MS).lean();
  if (!found) throw invalid('Pin must reference a publicly eligible CMS News story with a configured tag');
}

function actorId(actor) {
  if (!actor?.id) throw new Error('Missing authenticated actor');
  return String(actor.id);
}

async function createTopic(body, actor, now = new Date()) {
  const payload = createInput.parse(body);
  const topic = new EditorialTopic({ ...payload, createdBy: actorId(actor), updatedBy: actorId(actor) });
  await topic.validate();
  await validatePin(topic, now);
  await topic.save();
  return adminTopic(topic);
}

async function findAdminTopic(id) {
  const topic = await EditorialTopic.findById(parseId(id)).maxTimeMS(QUERY_MS);
  if (!topic) throw new TopicError(404, 'TOPIC_NOT_FOUND', 'Topic not found');
  return topic;
}

async function getAdminTopic(id) {
  return adminTopic(await findAdminTopic(id));
}

async function updateTopic(id, body, actor, now = new Date()) {
  const patch = patchInput.parse(body);
  const topic = await findAdminTopic(id);
  if (patch.name) patch.name = { ...topic.toObject().name, ...patch.name };
  if (patch.description) patch.description = { ...topic.toObject().description, ...patch.description };
  topic.set({ ...patch, updatedBy: actorId(actor) });
  await topic.validate();
  if ('pinnedArticleId' in patch || 'articleTags' in patch || patch.active === true) await validatePin(topic, now);
  await topic.save();
  return adminTopic(topic);
}

async function listAdminTopics(query) {
  const { active, page, limit } = parseQuery(query, 'admin');
  const filter = active === 'all' ? {} : { active: active === 'true' };
  const [docs, total] = await Promise.all([
    EditorialTopic.find(filter).sort({ order: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).maxTimeMS(QUERY_MS).lean(),
    EditorialTopic.countDocuments(filter).maxTimeMS(QUERY_MS),
  ]);
  return { items: docs.map(adminTopic), ...pagination(total, page, limit, docs.length) };
}

module.exports = {
  QUERY_MS, handleTopicRequest, parseQuery, storyPagePipeline, listPublicTopics, getPublicTopic, listTopicStories,
  listAdminTopics, getAdminTopic, createTopic, updateTopic,
};
