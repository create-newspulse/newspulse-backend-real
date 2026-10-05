const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { buildPublicCategoryFilter, getCanonicalPublicCategoryKey } = require('../lib/categories');
const { canonicalizeSlug, slugifyUnicode, getSlugCandidates } = require('../lib/slug');
const { normalizeLang, localizeArticleForLang } = require('./mapArticleForLang');
const {
  buildPubliclyVisibleNewsArticleFilter,
  buildPubliclyVisiblePublicArticleFilter,
  getArticleBaseLocale,
  getAvailableArticleLocales,
} = require('./publicArticleVisibility.service');
const { normalizeTranslationGroupKey } = require('./translationGroupSync.service');
const { publicAuthorByline } = require('./authorByline.service');
const { normalizeTrackValue } = require('./communitySubmissionWorkflow');

const ORDINARY_CATEGORIES = Object.freeze([
  'regional', 'national', 'international', 'business', 'sports',
  'tech', 'tech-gadgets', 'faith-culture', 'glamour', 'lifestyle',
]);
const PROTECTED_ORIGINS = new Set([
  'community', 'community_reporter', 'communityreporter', 'journalist',
  'youth', 'youth_pulse', 'youthpulse',
  'inspiration', 'inspiration_hub', 'inspirationhub', 'pulse_dialogue', 'pulsedialogue',
]);
const ORIGIN_FIELDS = [
  'source', 'sourceType', 'submissionSource', 'sourceTrack', 'originType',
  'communityReportId', 'youthPulseSubmissionId', 'youthPulseContributorId',
  'pulseDialogue', 'isSponsored', 'isSponsoredArticle', 'isBreaking',
];
const PUBLIC_FIELDS = [
  '_id', 'status', 'title', 'description', 'summary', 'content', 'slug', 'slugs',
  'category', 'tags', 'track', 'topic', 'location', 'geo', 'stateTags', 'stateNames',
  'lang', 'language', 'originalLang', 'sourceLanguage', 'sourceArticleId',
  'translationKey', 'translationGroupId', 'publishedAt', 'date', 'createdAt', 'updatedAt', 'views',
  'imageUrl', 'imageURL', 'coverImageUrl', 'coverImage', 'image', 'thumbnail', 'images',
  'imageAlt', 'imageCaption', 'authorByline', 'seo', 'externalUrls', 'embeds', 'gallery',
  'spotlightEnabled', 'spotlightPinned', 'spotlightPriority', 'spotlightExpiresAt',
  'isSponsored', 'isSponsoredArticle', 'sponsorName', 'sponsorLabel', 'sponsorDisclosure',
  'sponsorCtaText', 'sponsorCtaUrl', 'sponsorDestinationUrl', 'sponsorFeatureEligible',
  'sponsorFeatureLinkedId',
];
const IDENTITY_FIELDS = [
  '_id', 'sourceArticleId', 'translationKey', 'translationGroupId', 'category',
  'sourceLanguage', 'originalLang', 'lang', 'language', 'publishedAt', 'createdAt',
  'geo', 'location', 'state', 'district', 'city', 'tags', 'stateTags',
  ...ORIGIN_FIELDS,
].join(' ');
const NEWS_FIELDS = `${PUBLIC_FIELDS.filter((field) => field !== 'authorByline').join(' ')} ${ORIGIN_FIELDS.join(' ')} body state district city translations translationStatus translationReviewStatus humanEdited authorByline.enabled authorByline.snapshot`;
const COPY_FIELDS = `_id sourceNewsId slug slugs language originalLang category createdAt coverImage imageURL coverImageUrl seo translations translationStatus status deletedAt publishedAt publishAt scheduledAt visibility isPrivate ${ORIGIN_FIELDS.join(' ')}`;

function isOrdinaryNewsCategory(category) {
  return ORDINARY_CATEGORIES.includes(getCanonicalPublicCategoryKey(category));
}

function isOrdinaryPublication(doc, { allowUncategorized = false } = {}) {
  if (!doc || (!isOrdinaryNewsCategory(doc.category)
    && !(allowUncategorized && !getCanonicalPublicCategoryKey(doc.category)))) return false;
  if (doc.isSponsored || doc.isSponsoredArticle || doc.isBreaking || doc.pulseDialogue
    || doc.communityReportId || doc.youthPulseSubmissionId || doc.youthPulseContributorId
    || normalizeTrackValue(doc.sourceTrack)) return false;
  return !['source', 'sourceType', 'submissionSource', 'originType'].some((field) =>
    PROTECTED_ORIGINS.has(String(doc[field] || '').trim().toLowerCase().replace(/[\s-]+/g, '_'))
  );
}

function id(value) {
  return value == null ? '' : String(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function language(doc) {
  return normalizeLang(doc?.language) || normalizeLang(doc?.lang) || normalizeLang(doc?.originalLang);
}

function groupKey(doc) {
  const key = normalizeTranslationGroupKey(doc?.translationKey);
  const group = normalizeTranslationGroupKey(doc?.translationGroupId);
  return key && group && key !== group ? null : key || group;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function locationSlug(value, field) {
  const raw = String(value || '').trim();
  const slug = slugifyUnicode(raw.replace(/^(?:state|district|city)\s*:\s*/i, ''), { maxLength: 80 });
  return field === 'state' && ['gj', 'ગુજરાત', 'गुजरात'].includes(slug) ? 'gujarat' : slug;
}

function optionalLocation(value, field) {
  const raw = String(value || '').trim();
  if (/^(?:undefined|null|all|any|\*|all[\s-]?(?:districts|cities))$/i.test(raw)) return '';
  return locationSlug(raw, field);
}

function geography(doc, category) {
  const tags = {};
  for (const tag of Array.isArray(doc?.tags) ? doc.tags : []) {
    const match = typeof tag === 'string' && tag.match(/^\s*(state|district|city)\s*:\s*(.+?)\s*$/i);
    if (match) tags[match[1].toLowerCase()] = match[2];
  }
  const geo = {};
  for (const field of ['state', 'district', 'city']) {
    const value = [
      doc?.geo?.[field], doc?.location?.[`${field}Slug`], doc?.location?.[field],
      doc?.[field], tags[field],
    ].find((candidate) => text(candidate));
    geo[field] = locationSlug(value, field) || null;
  }
  if (category === 'regional') geo.state = 'gujarat';
  return geo;
}

function fullBucket(bucket) {
  return Boolean(text(bucket?.title) && text(bucket?.summary) && text(bucket?.content));
}

async function findNews(filter, select = NEWS_FIELDS) {
  return News.find(filter).select(select).maxTimeMS(10000).lean();
}

async function loadIdentities(candidates) {
  const identities = new Map(candidates.map((doc) => [id(doc._id), doc]));
  const ids = [...new Set(candidates.flatMap((doc) => [id(doc._id), id(doc.sourceArticleId)]).filter(Boolean))];
  const keys = [...new Set(candidates.flatMap((doc) => {
    const key = groupKey(doc);
    return key ? [key, doc.translationKey, doc.translationGroupId].filter(Boolean) : [];
  }))];
  const clauses = [{ _id: { $in: ids } }, { sourceArticleId: { $in: ids } }];
  if (keys.length) clauses.push({ translationKey: { $in: keys } }, { translationGroupId: { $in: keys } });
  for (const doc of await findNews({ $or: clauses }, IDENTITY_FIELDS)) {
    identities.set(id(doc._id), doc);
  }
  const attempted = new Set();
  while (true) {
    const parents = [...new Set([...identities.values()].map((doc) => id(doc.sourceArticleId))
      .filter((parent) => parent && !identities.has(parent) && !attempted.has(parent)))];
    if (!parents.length) break;
    for (const parent of parents) attempted.add(parent);
    for (const doc of await findNews({ _id: { $in: parents } }, IDENTITY_FIELDS)) {
      identities.set(id(doc._id), doc);
    }
  }
  return identities;
}

function buildGroups(identities) {
  const roots = new Map();
  const explicitRoots = new Set();
  for (const doc of identities.values()) {
    let current = doc;
    const seen = new Set();
    while (current && current.sourceArticleId && id(current.sourceArticleId) !== id(current._id)) {
      if (seen.has(id(current._id))) {
        current = null;
        break;
      }
      seen.add(id(current._id));
      current = identities.get(id(current.sourceArticleId));
    }
    roots.set(id(doc._id), current ? id(current._id) : null);
    if (current && (seen.size || id(current.sourceArticleId) === id(current._id))) {
      explicitRoots.add(id(current._id));
    }
  }

  const byKey = new Map();
  const categoriesByKey = new Map();
  for (const doc of identities.values()) {
    const key = groupKey(doc);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, new Set());
    if (!categoriesByKey.has(key)) categoriesByKey.set(key, new Set());
    const category = getCanonicalPublicCategoryKey(doc.category);
    if (category) categoriesByKey.get(key).add(category);
    const root = roots.get(id(doc._id));
    if (explicitRoots.has(root)) byKey.get(key).add(root);
  }

  const groups = new Map();
  for (const doc of identities.values()) {
    const root = roots.get(id(doc._id));
    if (!root) continue; // Unverifiable ancestry must not bypass a missing/deleted source.
    const key = groupKey(doc);
    const linkedRoots = key ? byKey.get(key) : null;
    const masterId = explicitRoots.has(root) ? root
      : linkedRoots?.size === 1 ? [...linkedRoots][0] : null;
    const categories = key ? categoriesByKey.get(key) : null;
    const category = getCanonicalPublicCategoryKey(doc.category)
      || (categories?.size === 1 ? [...categories][0] : '');
    const groupId = masterId ? `news:${masterId}`
      : key && !linkedRoots?.size ? `group:${key}:${category}`
        : `news:${id(doc._id)}`;
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, masterId, members: [] });
    groups.get(groupId).members.push(doc);
  }

  for (const group of [...groups.values()]) {
    if (group.masterId) continue;
    const languages = group.members.map(language).filter(Boolean);
    if (new Set(languages).size !== languages.length) {
      groups.delete(group.id);
      for (const doc of group.members) {
        const groupId = `news:${id(doc._id)}`;
        groups.set(groupId, { id: groupId, masterId: id(doc._id), members: [doc] });
      }
      continue;
    }
    const sourceLanguages = [...new Set(group.members.map((doc) => normalizeLang(doc.sourceLanguage)).filter(Boolean))];
    if (sourceLanguages.length === 1) {
      const masters = group.members.filter((doc) => language(doc) === sourceLanguages[0]);
      if (masters.length === 1) group.masterId = id(masters[0]._id);
    }
    const categoryOwners = group.members.filter((doc) => getCanonicalPublicCategoryKey(doc.category));
    if (!group.masterId && categoryOwners.length === 1) group.masterId = id(categoryOwners[0]._id);
    if (group.members.length === 1) group.masterId = id(group.members[0]._id);
  }
  return groups;
}

function hasVisibleAncestry(doc, visibleById) {
  let current = doc;
  const seen = new Set();
  while (current.sourceArticleId && id(current.sourceArticleId) !== id(current._id)) {
    if (!isOrdinaryPublication(current, { allowUncategorized: true })) return false;
    const parentId = id(current.sourceArticleId);
    if (seen.has(parentId) || !visibleById.has(parentId)) return false;
    seen.add(parentId);
    current = visibleById.get(parentId);
    if (!current) return false;
  }
  return isOrdinaryPublication(current, { allowUncategorized: true });
}

async function loadCopies(docs, now, publicArticleShape) {
  const ids = docs.map((doc) => doc._id);
  const slugOwners = new Map();
  for (const doc of docs) {
    const slug = canonicalizeSlug(doc.slug);
    if (!slug) continue;
    if (!slugOwners.has(slug)) slugOwners.set(slug, new Set());
    slugOwners.get(slug).add(id(doc._id));
  }
  const clauses = [{ sourceNewsId: { $in: ids } }];
  if (slugOwners.size) {
    clauses.push({
      sourceNewsId: null,
      slug: { $in: [...slugOwners.keys()] },
    });
  }
  const copies = await PublicArticle.find({ $or: clauses }).select(publicArticleShape ? null : COPY_FIELDS).maxTimeMS(10000).lean();
  const visibleCopies = copies.length
    ? await PublicArticle.find({
      ...buildPubliclyVisiblePublicArticleFilter({ now }),
      _id: { $in: copies.map((copy) => copy._id) },
    }).select('_id').maxTimeMS(10000).lean() : [];
  const visibleIds = new Set(visibleCopies.map((copy) => id(copy._id)));
  const byNewsId = new Map();
  for (const copy of copies.sort((a, b) => compareId(id(a._id), id(b._id)))) {
    if (!isOrdinaryPublication(copy, { allowUncategorized: true })) continue;
    if (publicArticleShape && !visibleIds.has(id(copy._id))) continue;
    const owners = slugOwners.get(canonicalizeSlug(copy.slug));
    const newsId = id(copy.sourceNewsId) || (owners?.size === 1 ? [...owners][0] : '');
    if (!newsId) continue;
    const previous = byNewsId.get(newsId);
    if (!previous || (!previous.copy.sourceNewsId && copy.sourceNewsId)) {
      byNewsId.set(newsId, { copy, visible: visibleIds.has(id(copy._id)) });
    }
  }
  return byNewsId;
}

function resolvePublicProjection(copyInfo, desired) {
  if (!copyInfo?.visible || !getAvailableArticleLocales(copyInfo.copy).includes(desired)) return null;
  const copy = copyInfo.copy;
  const mapped = localizeArticleForLang({ ...copy, originalLang: getArticleBaseLocale(copy) }, desired, { fallbackToBase: false });
  if (!mapped || !fullBucket(mapped) || !text(mapped.slug)) return null;
  const candidates = getSlugCandidates(mapped.slug);
  const storedSlugs = [copy.slug, copy.slugs?.en, copy.slugs?.hi, copy.slugs?.gu];
  return storedSlugs.some((slug) => candidates.includes(slug)) ? mapped : null;
}

function pickVariant(docs, master, desired, copies, publicArticleShape = false) {
  const sourceLanguage = normalizeLang(master?.sourceLanguage) || normalizeLang(master?.originalLang) || language(master);
  const variants = [];
  for (const doc of docs) {
    const storedLanguage = language(doc) || (id(doc._id) === id(master?._id) ? sourceLanguage : null);
    const copyInfo = copies.get(id(doc._id));
    const copy = copyInfo?.copy;
    const publicMapped = publicArticleShape ? resolvePublicProjection(copyInfo, desired) : null;
    if (publicArticleShape && !publicMapped) continue;
    const summary = text(doc.description) || text(doc.summary);
    const content = text(doc.content) || text(doc.body);
    const rejected = String(doc.translationReviewStatus || '').trim().toLowerCase() === 'rejected';
    if (storedLanguage === desired && text(doc.title) && summary && content && !rejected) {
      variants.push({
        doc, copy, publicMapped, title: doc.title, summary, content,
        sourceLanguage: sourceLanguage || storedLanguage,
        provider: 'manual', generatedAt: doc.publishedAt || doc.createdAt || null,
        translated: false, rank: id(doc._id) === id(master?._id) ? 50 : doc.humanEdited ? 40 : 30,
      });
    }
    const status = String(doc.translationStatus?.[desired] || '').trim().toLowerCase();
    let bucket = doc.translations?.[desired];
    let ready = status === 'ready';
    if (!status && !fullBucket(bucket) && copyInfo?.visible) {
      bucket = copy.translations?.[desired];
      ready = String(copy.translationStatus?.[desired] || '').trim().toLowerCase() === 'ready';
    }
    if (ready && fullBucket(bucket) && !rejected) {
      variants.push({
        doc, copy, publicMapped, title: bucket.title, summary: bucket.summary, content: bucket.content,
        sourceLanguage: sourceLanguage || normalizeLang(doc.originalLang) || storedLanguage,
        provider: bucket.provider || 'google', generatedAt: bucket.generatedAt || doc.publishedAt || doc.createdAt || null,
        translated: true, rank: bucket.provider === 'manual' ? 35 : 20,
      });
    }
  }
  variants.sort((a, b) => b.rank - a.rank || compareId(id(a.doc._id), id(b.doc._id)));
  return variants[0] || null;
}

function publicationTime(master, docs) {
  if (master?.publishedAt != null && master.publishedAt !== '') {
    const value = timestamp(master.publishedAt);
    return value === null ? null : { sort: value, publishedAt: master.publishedAt, source: 'master' };
  }
  const dates = docs.map((doc) => timestamp(doc.publishedAt)).filter((value) => value !== null);
  if (dates.length) {
    const value = Math.min(...dates);
    return { sort: value, publishedAt: new Date(value), source: 'sibling' };
  }
  const created = docs.map((doc) => timestamp(doc.createdAt)).filter((value) => value !== null);
  return { sort: created.length ? Math.min(...created) : -Infinity, publishedAt: null, source: created.length ? 'createdAt' : 'missing' };
}

function serializeVariant(picked, group, chronology, geo, desired, category, availableLocales, legacyShape) {
  const { doc, copy } = picked;
  const publicArticleShape = legacyShape === 'public-article';
  const newsShape = legacyShape === 'news' || legacyShape === 'public-news';
  const base = publicArticleShape ? copy : doc;
  const localized = publicArticleShape ? picked.publicMapped : picked;
  const translated = publicArticleShape ? localized.isTranslated : picked.translated;
  const out = legacyShape === 'news' || publicArticleShape ? { ...base } : {};
  if (legacyShape !== 'news' && !publicArticleShape) {
    for (const field of PUBLIC_FIELDS) {
      if (doc[field] !== undefined) out[field] = doc[field];
    }
  }
  if (!publicArticleShape) out.authorByline = publicAuthorByline(out.authorByline);
  const slugs = legacyShape ? base.slugs : { ...(doc.slugs || {}) };
  if (!legacyShape) {
    for (const locale of ['en', 'hi', 'gu']) {
      if (text(copy?.slugs?.[locale])) slugs[locale] = copy.slugs[locale];
    }
  }
  const storedSlug = legacyShape ? base.slug : copy?.slug || doc.slug;
  const localizedSlug = publicArticleShape ? localized.slug : text(slugs?.[desired]) || storedSlug;
  const slug = legacyShape === 'public-news' ? storedSlug : localizedSlug;
  const copyImage = !legacyShape && (text(copy?.coverImage?.url) || text(copy?.imageURL) || text(copy?.coverImageUrl));
  const coverImage = copyImage ? { ...(copy.coverImage || {}), url: copyImage } : base.coverImage;
  return {
    ...out,
    id: id(base._id),
    newsId: id(doc._id),
    publicArticleId: copy ? id(copy._id) : null,
    publicCreatedAt: copy?.createdAt || null,
    storedSlug,
    storyGroupId: group.id,
    category: getCanonicalPublicCategoryKey(doc.category) === category ? doc.category : category,
    publishedAt: chronology.publishedAt,
    publicationTimeSource: chronology.source,
    sourceLanguage: picked.sourceLanguage,
    displayLanguage: desired,
    lang: desired,
    language: desired,
    requestedLang: desired,
    resolvedLang: desired,
    isTranslated: translated,
    isFallback: false,
    publicEligible: true,
    availableLocales,
    publishedLocales: availableLocales,
    title: localized.title,
    description: localized.summary,
    summary: localized.summary,
    content: localized.content,
    slug,
    canonicalSlug: localizedSlug,
    slugs,
    geo: legacyShape ? { ...(base.geo || {}), ...geo } : geo,
    ...(coverImage ? { coverImage } : {}),
    ...(copyImage ? {
      imageUrl: copyImage, imageURL: copyImage, coverImageUrl: copyImage,
    } : {}),
    ...(!newsShape && !publicArticleShape && copy?.seo?.canonicalUrl ? { seo: { ...(out.seo || {}), canonicalUrl: copy.seo.canonicalUrl } } : {}),
    translationProvider: localized.provider,
    translationGeneratedAt: localized.generatedAt,
    translationAvailability: {
      requestedLang: desired, requestedLanguage: desired,
      resolvedLang: desired, resolvedLanguage: desired,
      requestedLocalePublished: true, isFallback: false, isTranslated: translated,
      availableLocales, publishedLocales: availableLocales, fallbackEnabled: false,
    },
  };
}

async function listPublicStories({
  category, lang, state, district, city, nationalState,
  page = 1, limit = 20, additionalFilter = {}, now = new Date(), legacyShape = null,
}) {
  const categoryKey = getCanonicalPublicCategoryKey(category);
  const desired = normalizeLang(lang);
  if (!isOrdinaryNewsCategory(categoryKey) || !desired
    || ![null, 'news', 'public-news', 'public-article'].includes(legacyShape)
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error('Invalid ordinary category feed request'), { status: 400, statusCode: 400 });
  }
  const visibility = buildPubliclyVisibleNewsArticleFilter({ now });
  const candidates = (await findNews({
    $and: [visibility, { category: buildPublicCategoryFilter(categoryKey) }, additionalFilter],
  }, IDENTITY_FIELDS)).filter((doc) => isOrdinaryPublication(doc));
  const empty = { items: [], page, limit, total: 0, totalPages: 1, hasMore: false };
  if (!candidates.length) return empty;

  const identities = await loadIdentities(candidates);
  const visible = await findNews({ $and: [visibility, { _id: { $in: [...identities.keys()] } }] },
    legacyShape === 'news' ? null : NEWS_FIELDS);
  const visibleById = new Map(visible.map((doc) => [id(doc._id), doc]));
  const candidatesById = new Set(candidates.map((doc) => id(doc._id)));
  const ordinaryIdentities = new Map([...identities].filter(([key, doc]) =>
    isOrdinaryPublication(visibleById.get(key) || doc, { allowUncategorized: true })));
  const groups = buildGroups(ordinaryIdentities);
  const publicArticleShape = legacyShape === 'public-article';
  const copies = await loadCopies(visible, now, publicArticleShape);
  const requestedGeo = {
    state: optionalLocation(state, 'state'), district: optionalLocation(district, 'district'), city: optionalLocation(city, 'city'),
  };
  const resolved = [];

  for (const group of groups.values()) {
    if (!group.members.some((doc) => candidatesById.has(id(doc._id)))) continue;
    const master = group.masterId ? visibleById.get(group.masterId) || identities.get(group.masterId) : null;
    if (master && (!visibleById.has(group.masterId) || !isOrdinaryPublication(master)
      || getCanonicalPublicCategoryKey(master.category) !== categoryKey)) continue;
    const docs = group.members.map((doc) => visibleById.get(id(doc._id))).filter((doc) =>
      doc && hasVisibleAncestry(doc, visibleById)
        && (getCanonicalPublicCategoryKey(doc.category) === categoryKey
        || (!doc.category && master && (doc.sourceArticleId || groupKey(doc) === groupKey(master))))
    );
    if (!docs.length) continue;
    const geo = geography(master || docs[0], categoryKey);
    if (Object.entries(requestedGeo).some(([field, value]) => value && geo[field] !== value)) continue;
    if (nationalState && !(master || docs[0]).stateTags?.includes(nationalState)) continue;
    const picked = pickVariant(docs, master, desired, copies, publicArticleShape);
    if (!picked) continue;
    const chronology = publicationTime(master, docs);
    if (!chronology) continue;
    const availableLocales = ['en', 'hi', 'gu'].filter((locale) => pickVariant(docs, master, locale, copies, publicArticleShape));
    resolved.push({ item: serializeVariant(picked, group, chronology, geo, desired, categoryKey, availableLocales, legacyShape), sort: chronology.sort });
  }
  resolved.sort((a, b) => (a.sort === b.sort ? 0 : a.sort > b.sort ? -1 : 1)
    || compareId(a.item.storyGroupId, b.item.storyGroupId));
  const total = resolved.length;
  const offset = (page - 1) * limit;
  return {
    items: resolved.slice(offset, offset + limit).map((entry) => entry.item),
    page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1),
    hasMore: offset + limit < total,
  };
}

module.exports = { ORDINARY_CATEGORIES, isOrdinaryNewsCategory, isOrdinaryPublication, listPublicStories };
