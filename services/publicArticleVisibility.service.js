const { normalizeLang } = require('./mapArticleForLang');
const { detectLangFromContent, hasFullTranslation } = require('./articleTranslation.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function buildPubliclyVisibleNewsArticleFilter({ now = new Date() } = {}) {
  const nowDt = now instanceof Date ? now : new Date(now);
  return {
    $and: [
      { status: { $regex: '^published$', $options: 'i' } },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: nowDt } }] },
      // Scheduled publish safety: if publishAt exists and is in the future, hide it.
      { $or: [{ publishAt: null }, { publishAt: { $exists: false } }, { publishAt: { $lte: nowDt } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: nowDt } }] },
    ],
  };
}

function buildPubliclyVisiblePublicArticleFilter({ now = new Date() } = {}) {
  const nowDt = now instanceof Date ? now : new Date(now);
  return {
    $and: [
      { status: 'published' },
      // Defensive: avoid future-dated publish timestamps.
      { $or: [{ publishedAt: null }, { publishedAt: { $exists: false } }, { publishedAt: { $lte: nowDt } }] },
    ],
  };
}

function getArticleBaseLocale(articleLike) {
  const base = normalizeLang(articleLike?.originalLang) || normalizeLang(articleLike?.language) || normalizeLang(articleLike?.lang);
  return base || detectLangFromContent(articleLike?.content) || 'en';
}

function getAvailableArticleLocales(articleLike) {
  const base = getArticleBaseLocale(articleLike);
  const out = new Set([base]);

  for (const lang of SUPPORTED_LANGS) {
    if (lang === base) continue;

    const bucket = articleLike?.translations?.[lang];
    if (!hasFullTranslation(bucket)) continue;

    const status = articleLike?.translationStatus?.[lang] ?? null;
    // Backward compatibility: if status is missing/null but bucket is complete, treat it as available.
    if (status === 'ready' || status === null) out.add(lang);
  }

  return Array.from(out);
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  buildPubliclyVisibleNewsArticleFilter,
  buildPubliclyVisiblePublicArticleFilter,
  getArticleBaseLocale,
  getAvailableArticleLocales,
};
