const express = require('express');
const mongoose = require('mongoose');
const News = require('../models/News');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { evaluateModuleAccess, getFounderModulePolicy } = require('../services/founderAccessPolicyService');
const { isContentDatabaseUnavailable } = require('../lib/contentErrors');

const router = express.Router();
const LIST_FIELDS = '_id title description slug status category language lang coverImage coverImageUrl imageURL createdAt updatedAt';
const DETAIL_FIELDS = `${LIST_FIELDS} content tags editorialType track topic externalUrls embeds gallery seo location geo stateTags stateNames`;
// Keep legacy visibility/isPrivate predicates even though they are not current schema paths.
const READ_OPTIONS = { strictQuery: false };
const SORTS = { '-createdAt': { createdAt: -1, _id: -1 }, '-updatedAt': { updatedAt: -1, _id: -1 } };
const LIST_QUERY_KEYS = new Set(['page', 'limit', 'pageSize', 'sort', 'status']);

function failure(res, status, code, message) {
  return res.status(status).json({ ok: false, success: false, status, code, message });
}

function storageFailure(res, error) {
  const unavailable = isContentDatabaseUnavailable(error);
  const code = unavailable ? 'DB_UNAVAILABLE' : 'DRAFT_READ_FAILED';
  console.error('[own-drafts] Read failed', { code });
  return failure(res, unavailable ? 503 : 500, code, 'Drafts could not be loaded. Please try again.');
}

function privateResponse(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Pragma', 'no-cache');
  res.vary('Authorization');
  res.vary('Cookie');
  next();
}

async function authorizeOwnDraftRead(req, res, next) {
  const user = req._authUserDoc;
  if (!user || !mongoose.isObjectIdOrHexString(user._id)) {
    return failure(res, 401, 'UNAUTHORIZED', 'Unauthorized');
  }
  try {
    const policy = await getFounderModulePolicy({ readOnly: true });
    const now = new Date();
    if (!['addNews', 'draftDesk'].some(key => evaluateModuleAccess(user, key, policy, { now }).allowed)) {
      return failure(res, 403, 'DRAFT_READ_FORBIDDEN', 'Effective Add News or Draft Desk access is required.');
    }
    return next();
  } catch (error) {
    return storageFailure(res, error);
  }
}

const scalarIn = values => ({ $in: values, $not: { $type: 'array' } });

function ownDraftFilter(userId) {
  const now = new Date();
  return {
    createdByUserId: { $eq: new mongoose.Types.ObjectId(userId), $not: { $type: 'array' } },
    status: scalarIn(['draft']),
    deletedAt: scalarIn([null]),
    publishedAt: scalarIn([null]),
    scheduledAt: scalarIn([null]),
    publishAt: scalarIn([null]),
    workflow: { $not: { $type: 'array' } },
    locked: scalarIn([null, false]),
    'workflow.locked': scalarIn([null, false]),
    requiresFounderApproval: scalarIn([null, false]),
    workflowStage: scalarIn([null, 'draft', 'DRAFT']),
    'workflow.stage': scalarIn([null, 'draft', 'DRAFT']),
    visibility: scalarIn([null, 'public']),
    isPrivate: scalarIn([null, false]),
    embargoUntil: { $not: { $type: 'array' } },
    'workflow.embargoUntil': { $not: { $type: 'array' } },
    $and: [
      { $or: [{ workflow: null }, { workflow: { $type: 'object' } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $lte: now } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $lte: now } }] },
    ],
  };
}

function pickStrings(value, fields) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const field of fields) {
    if (typeof value[field] === 'string' || value[field] === null) out[field] = value[field];
  }
  return out;
}

function draftDto(doc, detail = false) {
  const article = { _id: String(doc._id), id: String(doc._id), ...pickStrings(doc, ['title', 'slug', 'status', 'category', 'imageURL']) };
  article.description = typeof doc.description === 'string' ? doc.description : null;
  article.summary = article.description;
  article.language = typeof doc.language === 'string' ? doc.language : (typeof doc.lang === 'string' ? doc.lang : null);
  article.lang = typeof doc.lang === 'string' ? doc.lang : article.language;
  for (const field of ['createdAt', 'updatedAt']) {
    if (doc[field] == null) article[field] = null;
    else if (doc[field] instanceof Date || typeof doc[field] === 'string') {
      const date = new Date(doc[field]);
      if (!Number.isNaN(date.getTime())) article[field] = date.toISOString();
    }
  }
  const cover = pickStrings(doc.coverImage, ['url', 'publicId', 'alt']);
  const coverUrl = [
    cover.url, typeof doc.coverImage === 'string' ? doc.coverImage : null, doc.coverImageUrl, doc.imageURL,
  ].find(value => typeof value === 'string' && value);
  article.coverImageUrl = coverUrl || null;
  if (!detail) return article;

  Object.assign(article, pickStrings(doc, ['editorialType', 'track', 'topic']));
  article.content = typeof doc.content === 'string' ? doc.content : null;
  article.body = article.content;
  article.coverImage = { url: article.coverImageUrl, publicId: cover.publicId || null, alt: cover.alt || null };
  for (const field of ['tags', 'externalUrls', 'embeds', 'gallery', 'stateTags', 'stateNames']) {
    article[field] = Array.isArray(doc[field]) ? doc[field].filter(value => typeof value === 'string') : [];
  }
  article.seo = pickStrings(doc.seo, ['metaTitle', 'metaDescription', 'canonicalUrl']);
  article.location = pickStrings(doc.location, ['state', 'stateSlug', 'district', 'districtSlug', 'city', 'citySlug', 'country']);
  if (typeof doc.location?.isUT === 'boolean' || doc.location?.isUT === null) article.location.isUT = doc.location.isUT;
  article.geo = pickStrings(doc.geo, ['state', 'district', 'city']);
  return article;
}

function pageNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
  return Math.max(1, Number(value));
}

const guards = [privateResponse, requireAdminAuth, authorizeOwnDraftRead];

router.get('/articles/own-drafts', ...guards, async (req, res) => {
  const page = pageNumber(req.query.page, 1);
  const requestedLimit = pageNumber(req.query.pageSize ?? req.query.limit, 20);
  const sort = req.query.sort ?? '-createdAt';
  if (Object.keys(req.query).some(key => !LIST_QUERY_KEYS.has(key))
      || (req.query.status !== undefined && req.query.status !== 'draft')
      || (req.query.pageSize !== undefined && req.query.limit !== undefined && req.query.pageSize !== req.query.limit)
      || page === null || requestedLimit === null
      || typeof sort !== 'string' || !Object.prototype.hasOwnProperty.call(SORTS, sort)) {
    return failure(res, 400, 'INVALID_DRAFT_QUERY', 'Use draft status, numeric pagination and -createdAt or -updatedAt sorting only.');
  }
  const limit = Math.min(requestedLimit, 100);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip) || skip > 2147483647) {
    return failure(res, 400, 'INVALID_DRAFT_QUERY', 'Requested page is out of range.');
  }
  try {
    const filter = ownDraftFilter(req._authUserDoc._id);
    const [docs, total] = await Promise.all([
      News.find(filter, null, READ_OPTIONS).select(LIST_FIELDS).sort(SORTS[sort]).skip(skip).limit(limit).lean(),
      News.countDocuments(filter, READ_OPTIONS),
    ]);
    const items = docs.map(doc => draftDto(doc));
    const pages = Math.ceil(total / limit);
    return res.json({
      ok: true, success: true, status: 200,
      data: { items, page, limit, total, pages },
      items, articles: items, total, page, limit, pages, sort,
    });
  } catch (error) {
    return storageFailure(res, error);
  }
});

router.get('/articles/own-drafts/:id', ...guards, async (req, res) => {
  if (Object.keys(req.query).length) {
    return failure(res, 400, 'INVALID_DRAFT_QUERY', 'Read an own draft by its CMS ID without localization or group parameters.');
  }
  const notFound = () => failure(res, 404, 'DRAFT_NOT_FOUND', 'Draft not found.');
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return notFound();
  try {
    const filter = { ...ownDraftFilter(req._authUserDoc._id), _id: new mongoose.Types.ObjectId(req.params.id) };
    const doc = await News.findOne(filter, null, READ_OPTIONS).select(DETAIL_FIELDS).lean();
    if (!doc) return notFound();
    const article = draftDto(doc, true);
    return res.json({ ok: true, success: true, status: 200, article, data: { article } });
  } catch (error) {
    return storageFailure(res, error);
  }
});

module.exports = router;
