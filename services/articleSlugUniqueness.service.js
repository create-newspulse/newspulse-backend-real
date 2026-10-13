const News = require('../models/News');
const { canonicalizeSlug, getSlugCandidates } = require('../lib/slug');
const UNOWNED_PUBLIC_COPY_FILTER = Object.freeze({
  sourceNewsId: null, sourceArticleId: null, translationGroupId: null, translationKey: null,
});

function getStoryKeys(doc) {
  return [...new Set([doc?.translationGroupId, doc?.translationKey]
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value && !['null', 'undefined'].includes(value.toLowerCase())))];
}

function getStorySlugs(doc) {
  return [...new Set([doc?.slug, ...['en', 'hi', 'gu'].map(lang => doc?.slugs?.[lang])]
    .filter(value => typeof value === 'string' && value.trim())
    .flatMap(value => getSlugCandidates(canonicalizeSlug(value))))];
}

function buildStoryIdentityFilter(doc) {
  const ids = [...new Map([doc?._id, doc?.sourceArticleId].filter(Boolean)
    .map(id => [String(id), id])).values()];
  const keys = getStoryKeys(doc);
  const clauses = ids.flatMap(id => [{ _id: id }, { sourceArticleId: id }]);
  if (keys.length) clauses.push(
    { translationGroupId: { $in: keys } },
    { translationKey: { $in: keys } }
  );
  return clauses.length ? { $or: clauses } : null;
}

async function assertArticleSlugsUnique(doc, options = {}) {
  const slugs = getStorySlugs(doc);
  if (!slugs.length) return;
  const value = slugs.length === 1 ? slugs[0] : { $in: slugs };
  const filter = { $or: ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu'].map(field => ({ [field]: value })) };
  const identity = buildStoryIdentityFilter(doc);
  if (doc?._id) filter._id = { $ne: doc._id };
  if (identity) filter.$nor = [identity];
  const existing = await News.findOne(filter, null, { session: options.session })
    .select('_id').lean();
  if (existing) {
    throw Object.assign(new Error('Slug already exists'), {
      status: 409, statusCode: 409, code: 'SLUG_CONFLICT',
    });
  }
}

async function assertSlugUnique(slug, excludeId, story = {}) {
  return assertArticleSlugsUnique({
    _id: excludeId, slug,
    sourceArticleId: story.sourceArticleId,
    translationGroupId: story.translationGroupId,
    translationKey: story.translationKey,
  });
}

module.exports = {
  getStoryKeys, getStorySlugs, buildStoryIdentityFilter,
  assertArticleSlugsUnique, assertSlugUnique, UNOWNED_PUBLIC_COPY_FILTER,
};
