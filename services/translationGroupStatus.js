const News = require('../models/News');
const { normalizeLanguage: normalizeLang } = require('../middleware/lang');
const { buildStoryIdentityFilter, getStoryKeys } = require('./articleSlugUniqueness.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];
const TRANSLATION_SOURCE_IDENTITY_INVALID = 'TRANSLATION_SOURCE_IDENTITY_INVALID';
const TRANSLATION_GROUP_FIELDS = '_id title slug status deletedAt lang language originalLang translationKey translationGroupId sourceArticleId sourceLanguage translationMeta.sourceArticleId translationMeta.sourceLanguage translationMeta.targetLanguage';

function identityError(message) {
  return Object.assign(new Error(`${message} Founder review is required.`), {
    status: 409, statusCode: 409, code: TRANSLATION_SOURCE_IDENTITY_INVALID,
  });
}

function declaredLanguage(value) {
  if (value == null || value === '') return null;
  const lang = typeof value === 'string' ? normalizeLang(value) : null;
  if (!lang) throw identityError('Invalid translation language metadata.');
  return lang;
}

function resolveBaseLang(doc) {
  return resolveRowLang(doc);
}

function resolveRowLang(doc) {
  const langs = new Set([doc?.lang, doc?.language, doc?.translationMeta?.targetLanguage]
    .map(declaredLanguage).filter(Boolean));
  if (langs.size > 1) throw identityError('Conflicting edition language metadata.');
  return [...langs][0] || declaredLanguage(doc?.originalLang);
}

function toIdString(v) {
  if (v == null || v === '') return null;
  const value = typeof v === 'string' ? v.trim() : typeof v.toHexString === 'function' ? v.toHexString() : '';
  if (!/^[a-f0-9]{24}$/i.test(value)) throw identityError('Invalid translation source or edition ID.');
  return value.toLowerCase();
}

function sourceIdFor(doc) {
  if (doc?.translationMeta != null && (typeof doc.translationMeta !== 'object' || Array.isArray(doc.translationMeta))) {
    throw identityError('Invalid translation source metadata.');
  }
  const ids = new Set([doc?.sourceArticleId, doc?.translationMeta?.sourceArticleId].map(toIdString).filter(Boolean));
  if (ids.size > 1) throw identityError('Conflicting translation source links.');
  return [...ids][0] || null;
}

function groupKeysFor(doc) {
  for (const field of ['translationGroupId', 'translationKey']) {
    if (doc?.[field] != null && typeof doc[field] !== 'string') throw identityError('Invalid translation group key.');
  }
  return getStoryKeys(doc);
}

function resolveSourceId(docs) {
  const ids = new Set(docs.map(sourceIdFor).filter(Boolean));
  if (ids.size !== 1) throw identityError('Translation source identity is missing or ambiguous.');
  return [...ids][0];
}

function resolveGroupKey(docs) {
  const keys = new Set(docs.flatMap(groupKeysFor));
  if (keys.size > 1) throw identityError('Conflicting translation group keys.');
  return [...keys][0] || null;
}

function hasIndependentSourceLink(docs, sourceId) {
  return docs.some(row => toIdString(row._id) !== sourceId && sourceIdFor(row) === sourceId);
}

function assertSourceLanguage(doc, baseLang) {
  for (const value of [doc?.sourceLanguage, doc?.translationMeta?.sourceLanguage]) {
    const lang = declaredLanguage(value);
    if (lang && lang !== baseLang) throw identityError('Conflicting translation source language.');
  }
}

function assertPublicCopyIdentity(doc, { sourceId, editionId, editionLanguage, groupKey, baseLang }) {
  const copySourceId = sourceIdFor(doc);
  if (toIdString(doc?.sourceNewsId) !== toIdString(editionId)
    || (copySourceId && copySourceId !== toIdString(sourceId))
    || groupKeysFor(doc).some(key => key !== groupKey)
    || resolveRowLang(doc) !== editionLanguage) {
    throw identityError('The public copy conflicts with its CMS translation edition.');
  }
  assertSourceLanguage(doc, baseLang);
}

function resolveTranslationGroup(requestedDoc, groupDocs, { allowDeletedDuplicates = false } = {}) {
  const requestedId = toIdString(requestedDoc?._id);
  if (!requestedId || !Array.isArray(groupDocs) || !groupDocs.length) {
    throw identityError('Translation group editions are missing.');
  }
  const byId = new Map();
  for (const row of groupDocs) {
    const id = toIdString(row?._id);
    if (!id || byId.has(id)) throw identityError('Translation group edition IDs are missing or ambiguous.');
    byId.set(id, row);
  }
  const requested = byId.get(requestedId);
  if (!requested) throw identityError('The requested translation edition is missing from the group.');

  const evidence = [requestedDoc, ...groupDocs];
  const sourceId = resolveSourceId(evidence);
  const source = byId.get(sourceId);
  if (!source) throw identityError('The linked translation source is missing.');
  const groupKey = resolveGroupKey(evidence);
  const baseLang = resolveBaseLang(source);
  if (!baseLang) throw identityError('The translation source language is missing.');
  if (resolveRowLang(requestedDoc) !== resolveRowLang(requested)) {
    throw identityError('The requested edition language changed.');
  }

  const languages = new Set();
  for (const row of groupDocs) {
    if (toIdString(row._id) !== sourceId && !toIdString(row.sourceArticleId)
      && (!groupKey || !groupKeysFor(row).includes(groupKey))) {
      throw identityError('A translation edition has no source or group linkage.');
    }
    const lang = resolveRowLang(row);
    const occupiesLanguage = !allowDeletedDuplicates || row.status !== 'deleted';
    if (!lang || (occupiesLanguage && languages.has(lang))) throw identityError('Translation edition languages are missing or ambiguous.');
    if (occupiesLanguage) languages.add(lang);
    assertSourceLanguage(row, baseLang);
  }
  assertSourceLanguage(requestedDoc, baseLang);
  return { source, baseLang, rows: groupDocs };
}

function statusGroupFilter(doc) {
  const id = toIdString(doc?._id);
  if (!id) throw identityError('The requested translation edition ID is missing.');
  const sourceId = sourceIdFor(doc);
  groupKeysFor(doc);
  return buildStoryIdentityFilter({ ...doc, _id: id, sourceArticleId: sourceId });
}

function editorGroupRows(requested, rows) {
  const languageCounts = new Map();
  for (const row of rows) {
    const lang = resolveRowLang(row);
    languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);
  }
  const hasDeletedDuplicate = rows.some(row =>
    row?.status === 'deleted' && languageCounts.get(resolveRowLang(row)) > 1);
  if (!hasDeletedDuplicate) return rows;

  // Validate retired evidence before excluding it from the editable edition DTO.
  const { source } = resolveTranslationGroup(requested, rows, { allowDeletedDuplicates: true });
  const active = rows.filter(row => row.status !== 'deleted');
  if (source.status === 'deleted' || source.deletedAt || requested.status === 'deleted' || requested.deletedAt
    || active.some(row => row.deletedAt)
    || !hasIndependentSourceLink(rows, toIdString(source._id))) {
    throw identityError('The active editor editions cannot be independently verified.');
  }
  return active;
}

async function historicalEditorStatus(requested, rows, { session, publicCopy } = {}) {
  const id = toIdString(requested._id);
  const lang = resolveRowLang(requested);
  const groupKey = resolveGroupKey([requested, ...rows]);
  if (!lang || requested.status !== 'published' || requested.deletedAt
    || rows.length !== 1 || toIdString(rows[0]._id) !== id || resolveRowLang(rows[0]) !== lang) {
    throw identityError('The historical edition cannot be verified independently.');
  }
  const PublicArticle = require('../models/Article');
  const copies = await PublicArticle.find({
    $or: [{ sourceNewsId: requested._id }, statusGroupFilter(requested)],
  }, null, { session }).select(`${TRANSLATION_GROUP_FIELDS} sourceNewsId`).lean();
  const copy = copies[0];
  if (copies.length !== 1 || copy.status !== 'published' || copy.deletedAt
    || toIdString(copy.sourceNewsId) !== id || resolveRowLang(copy) !== lang
    || (sourceIdFor(copy) && sourceIdFor(copy) !== id)
    || groupKeysFor(copy).some(key => key !== groupKey)
    || (publicCopy && toIdString(publicCopy._id) !== toIdString(copy._id))) {
    throw identityError('The historical edition public ownership is missing or ambiguous.');
  }
  const sourceLanguages = new Set([requested, ...rows, copy].flatMap(doc =>
    [doc.sourceLanguage, doc.translationMeta?.sourceLanguage].map(declaredLanguage).filter(Boolean)));
  if (sourceLanguages.size > 1) throw identityError('Conflicting translation source language.');
  const article = summarizeArticle(requested);
  const perLang = Object.fromEntries(SUPPORTED_LANGS.map(language => [language, {
    lang: language, present: language === lang ? true : null, presence: language === lang ? 'present' : null,
    isSource: false, isTranslatedChild: false, sourceArticleId: null, childArticleId: null,
    articleId: language === lang ? id : null,
    slug: language === lang ? article.slug : null, title: language === lang ? article.title : null,
    articleStatus: language === lang ? article.status : null,
  }]));
  // Verified edition ownership is not proof of a canonical source or of missing translations.
  return {
    groupKey,
    groupStatus: {
      baseLang: null, sourceArticleId: null, sourceArticle: null, siblingArticles: [],
      groupArticles: [article], presentLanguages: [lang], translatedChildLanguages: [], missingLanguages: [], perLang,
    },
  };
}

async function loadTranslationGroupStatus(doc, {
  publicCopy = false, session, allowDeletedDuplicates = false, editorRead = false,
} = {}) {
  let requested = doc;
  if (publicCopy) {
    const newsId = toIdString(doc?.sourceNewsId);
    if (!newsId) throw identityError('The public copy has no CMS edition link.');
    requested = await News.findById(newsId, null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
    if (!requested) throw identityError('The public copy CMS edition is missing.');
  }

  const filter = statusGroupFilter(requested);
  let rows = await News.find(filter, null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
  if (editorRead && ![requested, ...rows].some(row => sourceIdFor(row))) {
    return historicalEditorStatus(requested, rows, { session, publicCopy: publicCopy ? doc : null });
  }
  const sourceId = resolveSourceId([requested, ...rows]);
  const source = rows.find(row => toIdString(row._id) === sourceId)
    || await News.findById(sourceId, null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
  if (!source) throw identityError('The linked translation source is missing.');
  resolveSourceId([requested, ...rows, source]);
  const groupKey = resolveGroupKey([requested, ...rows, source]);

  // A legacy child may lack the source's key, or be connected only through another edition.
  const searchedIds = [toIdString(requested._id), sourceIdFor(requested)];
  if (!searchedIds.includes(sourceId) || (groupKey && !groupKeysFor(requested).includes(groupKey))) {
    const sourceFilter = statusGroupFilter({ _id: sourceId, translationGroupId: groupKey });
    rows = await News.find({ $or: [filter, sourceFilter] }, null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
  }
  // Mutation callers remain strict; only explicit editor reads may omit verified retired duplicates.
  const groupStatus = buildTranslationGroupStatus(requested, editorRead ? editorGroupRows(requested, rows) : rows, {
    allowDeletedDuplicates,
  });

  if (publicCopy) {
    assertPublicCopyIdentity(doc, {
      sourceId: groupStatus.sourceArticleId, editionId: requested._id,
      editionLanguage: resolveRowLang(requested), groupKey, baseLang: groupStatus.baseLang,
    });
  }
  return { groupStatus, groupKey };
}

async function resolveArticleSaveIdentity(doc, { session, allowDeletedDuplicates = false, includeGroupStatus = false } = {}) {
  const requestedId = toIdString(doc?._id);
  const rows = await News.find(statusGroupFilter(doc), null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
  const evidence = [doc, ...rows];
  resolveGroupKey(evidence);
  const declaredSources = evidence.map(sourceIdFor).filter(Boolean);
  const unresolved = {
    kind: 'unresolved', sourceArticleId: null, sourceLanguage: null,
    standalone: rows.length === 1 && toIdString(rows[0]._id) === requestedId,
  };
  const unresolvedIdentity = (members = rows) => {
    if (allowDeletedDuplicates && members.some(row => row.status === 'deleted')) {
      throw identityError('The source relationship for the soft-deleted edition history cannot be verified.');
    }
    return unresolved;
  };
  if (!declaredSources.length) {
    if (!unresolved.standalone) throw identityError('The historical edition relationships cannot be verified.');
    return unresolvedIdentity();
  }

  const sourceId = resolveSourceId(evidence);
  const source = rows.find(row => toIdString(row._id) === sourceId)
    || await News.findById(sourceId, null, { session }).select(TRANSLATION_GROUP_FIELDS).lean();
  if (!source) return unresolvedIdentity();

  const { groupStatus } = await loadTranslationGroupStatus(doc, { session, allowDeletedDuplicates });
  // An old self-link alone is not independent evidence that this edition is the source.
  const linkedEdition = hasIndependentSourceLink(evidence, sourceId);
  if (!linkedEdition) return { ...unresolvedIdentity(groupStatus.groupArticles), standalone: groupStatus.groupArticles.length === 1 };
  const deletedEditionIds = allowDeletedDuplicates
    ? groupStatus.groupArticles.filter(row => row.status === 'deleted').map(row => row.id).sort()
    : [];
  return {
    kind: sourceId === requestedId ? 'source' : 'translation',
    sourceArticleId: sourceId, sourceLanguage: groupStatus.baseLang, standalone: false,
    ...(deletedEditionIds.length ? { deletedEditionIds } : {}),
    ...(includeGroupStatus ? {
      allActiveEditionsDraft: groupStatus.groupArticles.every(row => row.status === 'draft' || row.status === 'deleted'),
    } : {}),
  };
}

function assertArticleSaveLanguage(current, proposed, identity) {
  const editionLanguage = resolveRowLang(proposed);
  if (identity.kind !== 'unresolved') {
    assertSourceLanguage(proposed, identity.sourceLanguage);
    if (!editionLanguage || (identity.kind === 'source' && editionLanguage !== identity.sourceLanguage)
      || (identity.kind === 'translation' && editionLanguage === identity.sourceLanguage)) {
      throw identityError('The proposed edition language conflicts with the verified canonical source language.');
    }
    return;
  }

  const previous = [current.sourceLanguage, current.translationMeta?.sourceLanguage].map(declaredLanguage);
  const next = [proposed.sourceLanguage, proposed.translationMeta?.sourceLanguage].map(declaredLanguage);
  const declared = next.find(Boolean);
  if (declared) assertSourceLanguage(proposed, declared);
  if (next.some((lang, index) => lang !== previous[index])
    || editionLanguage !== resolveRowLang(current)) {
    throw identityError('The canonical source language for this edition language change cannot be verified.');
  }
}

function summarizeArticle(doc, { isSource = false } = {}) {
  const item = doc && typeof doc === 'object' ? doc : {};
  return {
    id: toIdString(item._id),
    lang: resolveRowLang(item),
    originalLang: normalizeLang(item?.originalLang),
    status: item?.status ? String(item.status) : null,
    slug: item?.slug ? String(item.slug) : null,
    title: item?.title ? String(item.title) : null,
    isSource,
  };
}

function buildTranslationGroupStatus(requestedDoc, groupDocs, { allowDeletedDuplicates = false } = {}) {
  const { source, baseLang, rows } = resolveTranslationGroup(requestedDoc, groupDocs, { allowDeletedDuplicates });
  const sourceId = toIdString(source._id);
  const sourceArticle = summarizeArticle({ ...source, originalLang: source?.originalLang || baseLang }, { isSource: true });

  const siblingArticles = rows
    .filter((row) => {
      const rowId = toIdString(row._id);
      return !(sourceId && rowId === sourceId);
    })
    .map((row) => summarizeArticle(row, { isSource: false }));

  const groupArticles = [sourceArticle, ...siblingArticles.filter((row) => row.id !== sourceArticle.id)];

  const childByLang = new Map();
  for (const row of rows) {
    const rowId = toIdString(row._id);
    if (sourceId && rowId === sourceId) continue;
    if (allowDeletedDuplicates && row.status === 'deleted') continue;

    childByLang.set(resolveRowLang(row), row);
  }

  const perLang = {};
  const presentLanguages = [];
  const translatedChildLanguages = [];
  const missingLanguages = [];

  for (const lang of SUPPORTED_LANGS) {
    const child = childByLang.get(lang) || null;
    const isSource = lang === baseLang;
    const present = isSource || Boolean(child);
    const presence = isSource ? 'source' : (child ? 'translated' : 'missing');

    perLang[lang] = {
      lang,
      present,
      presence,
      isSource,
      isTranslatedChild: Boolean(child) && !isSource,
      sourceArticleId: isSource ? sourceId : null,
      childArticleId: child ? toIdString(child._id) : null,
      articleId: isSource ? sourceId : (child ? toIdString(child._id) : null),
      slug: isSource ? sourceArticle.slug : (child ? summarizeArticle(child).slug : null),
      title: isSource ? sourceArticle.title : (child ? summarizeArticle(child).title : null),
      articleStatus: isSource ? sourceArticle.status : (child ? summarizeArticle(child).status : null),
    };

    if (present) presentLanguages.push(lang);
    else missingLanguages.push(lang);
    if (child && !isSource) translatedChildLanguages.push(lang);
  }

  return {
    baseLang,
    sourceArticleId: sourceId,
    sourceArticle,
    siblingArticles,
    groupArticles,
    presentLanguages,
    translatedChildLanguages,
    missingLanguages,
    perLang,
  };
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  resolveBaseLang,
  resolveRowLang,
  buildTranslationGroupStatus,
  loadTranslationGroupStatus,
  resolveArticleSaveIdentity,
  assertArticleSaveLanguage,
  resolvePersistedTranslationSourceId: sourceIdFor,
  translationSourceIdentityError: identityError,
  assertTranslationSourceLanguage: assertSourceLanguage,
  assertPublicCopyIdentity,
  TRANSLATION_GROUP_FIELDS,
  TRANSLATION_SOURCE_IDENTITY_INVALID,
};