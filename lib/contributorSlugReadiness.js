const { normalizeContributorSlug, normalizeContributorSlugHistory } = require('./contributorSlugHistory');

const HISTORY_INDEX = {
  key: { slugHistory: 1 },
  options: { name: 'slugHistory_1', unique: true, partialFilterExpression: { 'slugHistory.0': { $exists: true } } },
};

function contributorIndexReadiness(indexes) {
  const singleKey = (index, field) => Object.keys(index.key || {}).length === 1 && index.key[field] === 1;
  const unique = index => index.unique === true && !index.sparse && !index.hidden
    && !Object.hasOwn(index, 'expireAfterSeconds') && (!index.collation || index.collation.locale === 'simple');
  const slug = indexes.some(index => index.name === 'slug_1' && singleKey(index, 'slug') && unique(index) && !index.partialFilterExpression);
  const slugHistory = indexes.some(index => {
    const partial = index.partialFilterExpression;
    return index.name === 'slugHistory_1' && singleKey(index, 'slugHistory') && unique(index)
      && partial && Object.keys(partial).length === 1
      && partial['slugHistory.0'] && Object.keys(partial['slugHistory.0']).length === 1
      && partial['slugHistory.0'].$exists === true;
  });
  return { slug, slugHistory, ready: slug && slugHistory };
}

async function contributorSlugCapabilities(Model, env = process.env) {
  if (String(env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED || '').trim().toLowerCase() !== 'true') return { slugRename: false };
  try {
    const indexes = await Model.collection.listIndexes({ maxTimeMS: 5000 }).toArray();
    if (!contributorIndexReadiness(indexes).ready) return { slugRename: false };
    const incomplete = await Model.collection.findOne({ $expr: { $not: [{ $and: [
      { $eq: [{ $type: '$slug' }, 'string'] },
      { $ne: ['$slug', ''] },
      { $in: ['$slug', { $cond: [{ $isArray: '$slugHistory' }, '$slugHistory', []] }] },
    ] }] } }, { projection: { _id: 1 }, maxTimeMS: 5000 });
    return { slugRename: !incomplete };
  } catch (_) {
    return { slugRename: false };
  }
}

async function initializeLegacyContributorHistory(Model, contributor) {
  if (contributor.slugHistory !== undefined || !contributor.slug
    || normalizeContributorSlug(contributor.slug) !== contributor.slug) return contributor;
  try {
    const conflict = await Model.exists({ _id: { $ne: contributor._id }, $or: [
      { slug: contributor.slug }, { slugHistory: contributor.slug },
    ] });
    if (conflict) return contributor;
    return await Model.findOneAndUpdate(
      { _id: contributor._id, slug: contributor.slug, slugHistory: { $exists: false } },
      { $set: { slugHistory: normalizeContributorSlugHistory([], contributor.slug) } },
      { new: true, runValidators: true }
    ) || contributor;
  } catch (_) {
    return contributor;
  }
}

module.exports = { HISTORY_INDEX, contributorIndexReadiness, contributorSlugCapabilities, initializeLegacyContributorHistory };