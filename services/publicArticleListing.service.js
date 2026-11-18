const Article = require('../models/Article');
const News = require('../models/News');
const { getStoryKeys } = require('./articleSlugUniqueness.service');
const {
  resolvePersistedTranslationSourceId, translationSourceIdentityError, TRANSLATION_SOURCE_IDENTITY_INVALID,
} = require('./translationGroupStatus');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');

const BATCH_SIZE = 100;
const QUERY_MS = 2500;
const SORT = { publishedAt: -1, createdAt: -1 };
const PUBLIC_LISTING_IDENTITY_FIELDS = '_id sourceNewsId sourceArticleId translationGroupId translationKey translationMeta.sourceArticleId';
const CANDIDATE_FIELDS = `${PUBLIC_LISTING_IDENTITY_FIELDS} publishedAt createdAt updatedAt`;
const PARENT_FIELDS = [
  '_id sourceArticleId translationMeta.sourceArticleId translationGroupId translationKey',
  'status deletedAt locked embargoUntil publishedAt publishAt scheduledAt visibility isPrivate',
  'workflow.locked workflow.embargoUntil',
].join(' ');

function listingChanged() {
  return Object.assign(new Error('Public listing changed or timed out. Retry the request.'), { statusCode: 503 });
}

function queryOptions(deadline) {
  const maxTimeMS = Math.min(QUERY_MS, deadline - Date.now());
  if (maxTimeMS <= 0) throw listingChanged();
  return { maxTimeMS };
}

function identity(doc, publicCopy = false) {
  try {
    for (const field of ['translationGroupId', 'translationKey']) {
      if (doc[field] != null && typeof doc[field] !== 'string') {
        throw translationSourceIdentityError('Invalid translation group key.');
      }
    }
    const keys = getStoryKeys(doc);
    if (keys.length > 1) throw translationSourceIdentityError('Conflicting translation group keys.');
    return {
      ownerId: publicCopy ? resolvePersistedTranslationSourceId({ sourceArticleId: doc.sourceNewsId }) : null,
      sourceId: resolvePersistedTranslationSourceId({
        sourceArticleId: doc.sourceArticleId,
        translationMeta: { sourceArticleId: doc.translationMeta?.sourceArticleId },
      }),
      keys,
    };
  } catch (error) {
    if (error.code !== TRANSLATION_SOURCE_IDENTITY_INVALID) throw error;
    return { conflict: true };
  }
}

async function loadPublicArticleParents(ids, { parentDocs = new Map(), deadline = Date.now() + QUERY_MS, session } = {}) {
  const missing = [...new Set(ids)].filter(id => id && !parentDocs.has(id));
  if (!missing.length) return parentDocs;
  const rows = await News.find({ _id: { $in: missing } }, null, { ...queryOptions(deadline), session })
    .select(PARENT_FIELDS).lean();
  if (!Array.isArray(rows)) throw new Error('Invalid public listing parent lookup result');
  for (const id of missing) parentDocs.set(id, null);
  for (const row of rows) parentDocs.set(String(row._id), row);
  return parentDocs;
}

async function eligibleBatch(docs, { now, deadline, logger, parentDocs }) {
  const identities = docs.map(doc => identity(doc, true));
  const ids = [...new Set(identities.flatMap(item => [item.ownerId, item.sourceId]).filter(Boolean))];
  const parents = parentDocs || new Map();
  const parentIdentities = new Map();
  const load = async values => {
    await loadPublicArticleParents(values, { parentDocs: parents, deadline });
    for (const [id, row] of parents) if (row) parentIdentities.set(id, identity(row));
  };
  await load(ids);
  const canonicalIds = [...new Set(identities.map(item => (
    parentIdentities.get(item.ownerId || item.sourceId)?.sourceId
  )).filter(id => id && !parents.has(id)))];
  await load(canonicalIds);

  let conflicts = 0;
  const eligible = docs.filter((_doc, index) => {
    const copy = identities[index];
    const conflict = () => { conflicts += 1; return false; };
    if (copy.conflict) return conflict();
    const primaryId = copy.ownerId || copy.sourceId;
    if (!primaryId) return true;
    const primary = parents.get(primaryId);
    if (!isPubliclyVisibleNewsArticle(primary, { now })) return false;
    const primaryIdentity = parentIdentities.get(primaryId);
    if (primaryIdentity.conflict) return conflict();

    // A visible edition authorizes its own publication, not that of a deleted sibling.
    const canonicalId = copy.sourceId || primaryIdentity.sourceId || primaryId;
    if (primaryIdentity.sourceId && primaryIdentity.sourceId !== canonicalId) return conflict();
    const canonical = parentIdentities.get(canonicalId);
    if (!canonical) return false;
    if (canonical.conflict || (canonical.sourceId && canonical.sourceId !== canonicalId)) return conflict();
    if (new Set([...copy.keys, ...primaryIdentity.keys, ...canonical.keys]).size > 1) return conflict();
    return true;
  });
  if (conflicts) logger.warn('[public.articleListing] excluded conflicting ownership', {
    code: TRANSLATION_SOURCE_IDENTITY_INVALID, count: conflicts,
  });
  return eligible;
}

async function filterPublicListingCandidates(docs, { now = new Date(), logger = console, parentDocs } = {}) {
  if (!Array.isArray(docs)) throw new Error('Invalid public listing candidates');
  const options = { now, logger, deadline: Date.now() + QUERY_MS, parentDocs };
  const eligible = [];
  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    eligible.push(...await eligibleBatch(docs.slice(offset, offset + BATCH_SIZE), options));
  }
  return eligible;
}

function candidateSnapshot(doc) {
  return JSON.stringify([
    doc._id, doc.sourceNewsId, doc.sourceArticleId, doc.translationMeta?.sourceArticleId,
    doc.translationGroupId, doc.translationKey, doc.publishedAt, doc.createdAt, doc.updatedAt,
  ]);
}

async function listPublicArticlePage(filter, { skip = 0, limit, select, includeTotal = false } = {}) {
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw Object.assign(new Error('Invalid public listing pagination'), { statusCode: 400 });
  }
  const options = { now: new Date(), logger: console, deadline: Date.now() + QUERY_MS };
  // Only identity/ordering fields cross the wire for skipped or counted candidates.
  const cursor = Article.find(filter, null, { ...queryOptions(options.deadline), lean: true })
    .select(CANDIDATE_FIELDS).sort(SORT).cursor({ batchSize: BATCH_SIZE });
  const selected = [];
  let total = 0;
  let readFailed = false;
  try {
    while (true) {
      const batch = [];
      for (let index = 0; index < BATCH_SIZE; index += 1) {
        const doc = await cursor.next();
        if (!doc) break;
        batch.push(doc);
      }
      if (!batch.length) break;
      const eligible = await eligibleBatch(batch, options);
      for (const doc of eligible) {
        if (total >= skip && selected.length < limit) selected.push(doc);
        total += 1;
      }
      if ((!includeTotal && selected.length === limit) || batch.length < BATCH_SIZE) break;
      queryOptions(options.deadline);
    }
  } catch (error) {
    readFailed = true;
    throw error;
  } finally {
    try {
      await cursor.close();
    } catch (error) {
      if (!readFailed) throw error;
      console.warn('[public.articleListing] cursor cleanup failed after a read error', { name: error.name });
    }
  }
  if (!selected.length) return { docs: [], total };

  const pageFilter = {
    ...filter, $and: [...(filter.$and || []), { _id: { $in: selected.map(doc => doc._id) } }],
  };
  const query = Article.find(pageFilter, null, queryOptions(options.deadline));
  if (select) query.select(`${select} ${CANDIDATE_FIELDS}`);
  const rows = await query.limit(limit).lean();
  if (!Array.isArray(rows)) throw new Error('Invalid public listing page result');
  const byId = new Map(rows.map(doc => [String(doc._id), doc]));
  const docs = selected.map(doc => byId.get(String(doc._id)));
  if (rows.length !== selected.length || docs.some((doc, index) => (
    !doc || candidateSnapshot(doc) !== candidateSnapshot(selected[index])
  ))) throw listingChanged();
  if ((await eligibleBatch(docs, options)).length !== docs.length) throw listingChanged();
  return { docs, total };
}

module.exports = {
  PUBLIC_LISTING_IDENTITY_FIELDS, filterPublicListingCandidates, loadPublicArticleParents, listPublicArticlePage,
};
