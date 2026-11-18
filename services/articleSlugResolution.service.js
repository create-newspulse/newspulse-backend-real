const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { getSlugCandidates, pickLocalizedArticleSlug } = require('../lib/slug');
const { normalizeLang } = require('./mapArticleForLang');
const { getStoryKeys } = require('./articleSlugUniqueness.service');
const { resolvePersistedTranslationSourceId } = require('./translationGroupStatus');
const {
  buildPubliclyVisibleNewsArticleFilter, buildPubliclyVisiblePublicArticleFilter,
} = require('./publicArticleVisibility.service');
const {
  filterPublicListingCandidates, loadPublicArticleParents, PUBLIC_LISTING_IDENTITY_FIELDS,
} = require('./publicArticleListing.service');

const IDENTITY_FIELDS = `${PUBLIC_LISTING_IDENTITY_FIELDS} slug slugs lang language originalLang translationMeta.sourceArticleId`;

function ambiguousArticleSlug() {
  return Object.assign(new Error('Article slug is ambiguous. Use the article ID.'), {
    status: 409, statusCode: 409, code: 'ARTICLE_SLUG_AMBIGUOUS',
  });
}

function buildArticleSlugClause(value) {
  const candidates = getSlugCandidates(value);
  const match = candidates.length === 1 ? candidates[0] : { $in: candidates };
  return { $or: ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu'].map(field => ({ [field]: match })) };
}

function sourceId(value) {
  return resolvePersistedTranslationSourceId({ sourceArticleId: value });
}

function identity(doc, publicCopy, owners) {
  const keys = getStoryKeys(doc);
  if (keys.length > 1 || ['translationGroupId', 'translationKey']
    .some(field => doc[field] != null && typeof doc[field] !== 'string')) throw ambiguousArticleSlug();
  const ownerId = publicCopy ? sourceId(doc.sourceNewsId) : null;
  const owner = ownerId ? owners.get(ownerId) : null;
  if (ownerId && !owner) throw ambiguousArticleSlug();
  const declaredSource = resolvePersistedTranslationSourceId(doc);
  const ownerSource = owner ? resolvePersistedTranslationSourceId(owner) || ownerId : null;
  if (declaredSource && ownerSource && declaredSource !== ownerSource) throw ambiguousArticleSlug();
  const namespace = !publicCopy || ownerId || declaredSource ? 'news' : 'public';
  return {
    namespace, key: keys[0] || null,
    root: declaredSource || ownerSource || sourceId(doc._id),
    linked: Boolean(declaredSource || ownerId),
  };
}

function sameStory(left, right) {
  if (left.namespace !== right.namespace || left.key && right.key && left.key !== right.key) return false;
  if (left.root && left.root === right.root) return true;
  // Older independent editions can have a shared key without source links.
  return !left.linked && !right.linked && Boolean(left.key && left.key === right.key);
}

async function assertSameArticleStory(newsDocs, publicDocs = [], { session, parentDocs } = {}) {
  const owners = new Map(parentDocs);
  for (const doc of newsDocs) if (doc._id) owners.set(sourceId(doc._id), doc);
  const missingOwners = [...new Set(publicDocs.map(doc => sourceId(doc.sourceNewsId)).filter(id => id && !owners.has(id)))];
  if (missingOwners.length) {
    await loadPublicArticleParents(missingOwners, { parentDocs: owners, session });
  }
  const identities = [
    ...newsDocs.map(doc => identity(doc, false, owners)),
    ...publicDocs.map(doc => identity(doc, true, owners)),
  ];
  for (let index = 0; index < identities.length; index += 1) {
    if (identities.slice(index + 1).some(other => !sameStory(identities[index], other))) throw ambiguousArticleSlug();
  }
}

function pickEdition(docs, lang) {
  if (!docs.length) return null;
  const language = doc => normalizeLang(doc.language || doc.lang || doc.originalLang);
  const desired = normalizeLang(lang);
  const localized = desired ? docs.filter(doc => language(doc) === desired) : [];
  const candidates = localized.length ? localized : [...docs].sort((a, b) => {
    const sourceOrder = doc => {
      const source = resolvePersistedTranslationSourceId(doc);
      return source && source !== sourceId(doc._id) ? 1 : 0;
    };
    return sourceOrder(a) - sourceOrder(b) || String(a._id).localeCompare(String(b._id));
  });
  const selected = candidates[0];
  if (docs.filter(doc => language(doc) === language(selected)).length > 1) throw ambiguousArticleSlug();
  return selected;
}

async function findArticleSlugMatches(value, {
  requestedLang, publicOnly = true, newsSelect, articleSelect, parentDocs = new Map(),
} = {}) {
  const clause = buildArticleSlugClause(value);
  const filter = base => ({ ...base, $and: [...(base.$and || []), clause] });
  const newsQuery = News.find(filter(publicOnly ? buildPubliclyVisibleNewsArticleFilter() : {}));
  const publicQuery = PublicArticle.find(filter(publicOnly ? buildPubliclyVisiblePublicArticleFilter() : {}));
  if (newsSelect) newsQuery.select(`${newsSelect} ${IDENTITY_FIELDS}`);
  if (articleSelect) publicQuery.select(`${articleSelect} ${IDENTITY_FIELDS}`);
  const [news, copies] = await Promise.all([newsQuery.lean(), publicQuery.lean()]);
  const publicArticles = publicOnly ? await filterPublicListingCandidates(copies, { parentDocs }) : copies;
  await assertSameArticleStory(news, publicArticles, { parentDocs });
  return {
    news: pickEdition(news, requestedLang),
    publicArticle: pickEdition(publicArticles, requestedLang),
  };
}

async function resolveCanonicalArticleSlug(doc, lang, {
  resolvedAlias, publicCopy = false, publicOnly = true, parentDocs = new Map(),
} = {}) {
  const slug = pickLocalizedArticleSlug(doc, lang);
  const id = pickLocalizedArticleSlug({ _id: doc?._id }, lang);
  // Normalizing a legacy alias can produce a different, unregistered URL.
  if (!slug || slug === id || resolvedAlias === slug) return slug;

  let code = 'ARTICLE_SLUG_UNRESOLVED';
  try {
    const matches = await findArticleSlugMatches(slug, {
      requestedLang: lang, publicOnly, newsSelect: IDENTITY_FIELDS, articleSelect: IDENTITY_FIELDS, parentDocs,
    });
    if (matches.news || matches.publicArticle) {
      const news = publicCopy ? [] : [doc];
      const copies = publicCopy ? [doc] : [];
      if (matches.news) news.push(matches.news);
      if (matches.publicArticle) copies.push(matches.publicArticle);
      await assertSameArticleStory(news, copies, { parentDocs });
      return slug;
    }
  } catch (error) {
    if (!['ARTICLE_SLUG_AMBIGUOUS', 'TRANSLATION_SOURCE_IDENTITY_INVALID'].includes(error?.code)) throw error;
    code = error.code;
  }
  console.warn('[articles.slug] Canonical alias rejected; using article ID', { code, articleId: id });
  if (!id) throw ambiguousArticleSlug();
  return id;
}

module.exports = {
  buildArticleSlugClause, findArticleSlugMatches, resolveCanonicalArticleSlug, assertSameArticleStory, ambiguousArticleSlug,
};
