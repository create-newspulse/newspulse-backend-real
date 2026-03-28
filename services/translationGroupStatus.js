const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function resolveBaseLang(doc) {
  return normalizeLang(doc?.originalLang) || normalizeLang(doc?.lang) || normalizeLang(doc?.language) || 'en';
}

function resolveRowLang(doc) {
  return normalizeLang(doc?.lang) || normalizeLang(doc?.language) || normalizeLang(doc?.originalLang) || null;
}

function toIdString(v) {
  if (!v) return null;
  return String(v);
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

function buildTranslationGroupStatus(sourceDoc, groupDocs) {
  const source = sourceDoc && typeof sourceDoc === 'object' ? sourceDoc : {};
  const baseLang = resolveBaseLang(source);
  const sourceId = toIdString(source._id);
  const rows = Array.isArray(groupDocs) ? groupDocs.filter((doc) => doc && typeof doc === 'object') : [];
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

    const lang = resolveRowLang(row);
    if (!lang) continue;

    const existing = childByLang.get(lang);
    if (!existing) {
      childByLang.set(lang, row);
      continue;
    }

    const existingId = toIdString(existing._id);
    if (!existingId && rowId) childByLang.set(lang, row);
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
};