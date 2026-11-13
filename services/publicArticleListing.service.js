const News = require('../models/News');
const { getStoryKeys } = require('./articleSlugUniqueness.service');
const {
  resolvePersistedTranslationSourceId, translationSourceIdentityError, TRANSLATION_SOURCE_IDENTITY_INVALID,
} = require('./translationGroupStatus');
const { isPubliclyVisibleNewsArticle } = require('./publicArticleVisibility.service');

const BATCH_SIZE = 100;
const QUERY_MS = 2500;
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

async function eligibleBatch(docs, { now, deadline, logger }) {
  const identities = docs.map(doc => identity(doc, true));
  const ids = [...new Set(identities.flatMap(item => [item.ownerId, item.sourceId]).filter(Boolean))];
  const parents = new Map();
  const parentIdentities = new Map();
  const load = async values => {
    if (!values.length) return;
    const rows = await News.find({ _id: { $in: values } }, null, queryOptions(deadline))
      .select(PARENT_FIELDS).lean();
    if (!Array.isArray(rows)) throw new Error('Invalid public listing parent lookup result');
    for (const row of rows) {
      const id = String(row._id);
      parents.set(id, row);
      parentIdentities.set(id, identity(row));
    }
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

async function filterPublicListingCandidates(docs, { now = new Date(), logger = console } = {}) {
  if (!Array.isArray(docs)) throw new Error('Invalid public listing candidates');
  const options = { now, logger, deadline: Date.now() + QUERY_MS };
  const eligible = [];
  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    eligible.push(...await eligibleBatch(docs.slice(offset, offset + BATCH_SIZE), options));
  }
  return eligible;
}

module.exports = { filterPublicListingCandidates };
