const mongoose = require('mongoose');
const News = require('../models/News');
const { buildStoryIdentityFilter } = require('./articleSlugUniqueness.service');

const IDENTITY_FIELDS = ['_id', 'sourceArticleId', 'translationGroupId', 'translationKey'];
const SELECT = `${IDENTITY_FIELDS.join(' ')} status deletedAt`;
const BATCH_SIZE = 200;
const QUERY_MS = 2500;
const STATUSES = new Set(['published', 'draft', 'scheduled', 'deleted', 'archived']);

function identityConflict() {
  return Object.assign(new Error('Story identity is inconsistent. Review the source links and translation keys.'), {
    statusCode: 409,
    code: 'ARTICLE_LOGICAL_IDENTITY_CONFLICT',
  });
}

function valueKey(value) {
  if (value instanceof mongoose.Types.ObjectId) return `objectId:${value.toHexString()}`;
  return `${typeof value}:${String(value)}`;
}

function identityTerms(doc) {
  const identity = buildStoryIdentityFilter(doc);
  if (!identity) throw identityConflict();
  // Match the lifecycle find's casting, including ObjectId versus legacy string values.
  const filter = new mongoose.Query().cast(News, identity);
  return filter.$or.flatMap(clause => Object.entries(clause).flatMap(([field, match]) =>
    (match?.$in || [match]).map(value => ({ field, value, key: valueKey(value) }))));
}

function effectiveStatus(doc) {
  const status = Object.hasOwn(doc, 'status') ? doc.status : 'draft';
  if (!STATUSES.has(status) || (status !== 'deleted' && doc.deletedAt)) return 'mixed';
  return status;
}

function readArticles(filter, session, options) {
  const query = News.find(filter, null, { session })
    .select(options.select ? `${SELECT} ${options.select}` : SELECT).maxTimeMS(QUERY_MS);
  if (options.maxDocuments) query.limit(options.maxDocuments + 1);
  if (options.collation) query.collation(options.collation);
  return query.lean();
}

async function readLogicalArticleGroups(filter, session, options = {}) {
  const docs = new Map();
  const identities = new Map();
  const pending = [];
  const add = doc => {
    const id = valueKey(doc._id);
    if (docs.has(id)) return;
    if (options.maxDocuments && docs.size >= options.maxDocuments) {
      throw Object.assign(new Error('Too many story editions matched. Narrow the story selection.'), {
        statusCode: 503, code: 'ARTICLE_LOGICAL_QUERY_TOO_LARGE',
      });
    }
    docs.set(id, doc);
    identities.set(id, identityTerms(doc));
    pending.push(id);
  };
  for (const doc of await readArticles(filter, session, options)) add(doc);

  // Expand only selected stories, batching and deduplicating the existing helper's predicates.
  const queried = new Set();
  for (let offset = 0; offset < pending.length;) {
    const batch = pending.slice(offset, offset + BATCH_SIZE);
    offset += batch.length;
    const fields = new Map();
    for (const id of batch) {
      for (const term of identities.get(id)) {
        const token = `${term.field}:${term.key}`;
        if (queried.has(token)) continue;
        queried.add(token);
        if (term.field === '_id' && docs.has(term.key)) continue;
        if (!fields.has(term.field)) fields.set(term.field, []);
        fields.get(term.field).push(term.value);
      }
    }
    if (!fields.size) continue;
    const clauses = [...fields].map(([field, values]) => ({ [field]: { $in: values } }));
    for (const doc of await readArticles({ $or: clauses }, session, options)) add(doc);
  }

  const indexes = new Map(IDENTITY_FIELDS.map(field => [field, new Map()]));
  for (const [id, doc] of docs) {
    for (const field of IDENTITY_FIELDS) {
      if (doc[field] == null) continue;
      const index = indexes.get(field);
      const values = Array.isArray(doc[field]) ? doc[field] : [doc[field]];
      for (const value of values) {
        const key = valueKey(value);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(id);
      }
    }
  }

  const owners = new Map();
  const groups = new Map();
  for (const id of docs.keys()) {
    const members = new Set();
    for (const { field, key } of identities.get(id)) {
      for (const member of indexes.get(field).get(key) || []) members.add(member);
    }
    if (!members.has(id)) throw identityConflict();
    const signature = JSON.stringify([...members].sort());
    // Overlap is not permission to invent a transitive story identity.
    for (const member of members) {
      if (owners.has(member) && owners.get(member) !== signature) throw identityConflict();
      owners.set(member, signature);
    }
    if (groups.has(signature)) continue;
    groups.set(signature, [...members].map(member => docs.get(member)));
  }
  return [...groups.values()];
}

async function readLogicalCounts(filter, session) {
  const groups = await readLogicalArticleGroups(filter, session);
  const counts = { published: 0, draft: 0, scheduled: 0, deleted: 0, archived: 0, mixed: 0 };
  for (const members of groups) {
    const statuses = new Set(members.map(effectiveStatus));
    counts[statuses.size === 1 ? [...statuses][0] : 'mixed'] += 1;
  }
  return { unit: 'logical-story', total: groups.length, counts };
}

async function countLogicalArticles(filter) {
  const session = await mongoose.startSession();
  let result;
  try {
    // All membership reads must observe the same lifecycle state without taking a write guard.
    await session.withTransaction(async () => {
      result = await readLogicalCounts(filter, session);
    }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { countLogicalArticles, readLogicalArticleGroups };
