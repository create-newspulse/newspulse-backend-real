const { normalizeLang } = require('./mapArticleForLang');
const { detectLangFromContent, hasFullTranslation } = require('./articleTranslation.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function buildPubliclyVisibleNewsArticleFilter({ now = new Date() } = {}) {
  const nowDt = now instanceof Date ? now : new Date(now);
  return {
    $and: [
      { status: 'published' },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      { $or: [{ locked: { $ne: true } }, { locked: { $exists: false } }] },
      { $or: [{ embargoUntil: null }, { embargoUntil: { $exists: false } }, { embargoUntil: { $lte: nowDt } }] },
      { $or: [{ publishedAt: null }, { publishedAt: { $exists: false } }, { publishedAt: { $lte: nowDt } }] },
      // Scheduled publish safety: if publishAt exists and is in the future, hide it.
      { $or: [{ publishAt: null }, { publishAt: { $exists: false } }, { publishAt: { $lte: nowDt } }] },
      { $or: [{ scheduledAt: null }, { scheduledAt: { $exists: false } }, { scheduledAt: { $lte: nowDt } }] },
      { $or: [{ visibility: { $ne: 'private' } }, { visibility: { $exists: false } }] },
      { $or: [{ isPrivate: { $ne: true } }, { isPrivate: { $exists: false } }] },
      // Some docs may only have workflow.* fields; keep public feed safe.
      { $or: [{ 'workflow.locked': { $ne: true } }, { 'workflow.locked': { $exists: false } }] },
      { $or: [{ 'workflow.embargoUntil': null }, { 'workflow.embargoUntil': { $exists: false } }, { 'workflow.embargoUntil': { $lte: nowDt } }] },
    ],
  };
}

function buildPubliclyVisiblePublicArticleFilter(options = {}) {
  return buildPubliclyVisibleNewsArticleFilter(options);
}

function isPubliclyVisibleNewsArticle(docLike, { now = new Date() } = {}) {
  const doc = typeof docLike?.toObject === 'function' ? docLike.toObject() : docLike;
  if (!doc || doc.status !== 'published' || doc.deletedAt != null
    || doc.locked === true || doc.workflow?.locked === true
    || doc.visibility === 'private' || doc.isPrivate === true) return false;
  const deadline = new Date(now).getTime();
  return [doc.publishedAt, doc.publishAt, doc.scheduledAt, doc.embargoUntil, doc.workflow?.embargoUntil]
    .every(value => value == null || new Date(value).getTime() <= deadline);
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

function buildEditorialEligibilityFilter() {
  return {
    $and: [
      { isSponsored: { $ne: true } },
      { isSponsoredArticle: { $ne: true } },
      { sponsorFeatureLinkedId: null },
      { category: { $not: /^sponsored(?:[\s_-]|$)/i } },
    ],
  };
}

function isEditorialRankingEligible(doc) {
  return doc?.isSponsored !== true && doc?.isSponsoredArticle !== true
    && !doc?.sponsorFeatureLinkedId && !/^sponsored(?:[\s_-]|$)/i.test(String(doc?.category || ''));
}

async function hasVisibleNewsSource(doc) {
  const sourceId = doc?.sourceNewsId || doc?.sourceArticleId;
  if (!sourceId) return true;
  const News = require('../models/News');
  const source = await News.findOne({
    ...buildPubliclyVisibleNewsArticleFilter(), _id: sourceId,
  }).select('_id').lean();
  return Boolean(source);
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  buildPubliclyVisibleNewsArticleFilter,
  buildPubliclyVisiblePublicArticleFilter,
  getArticleBaseLocale,
  getAvailableArticleLocales,
  buildEditorialEligibilityFilter,
  isEditorialRankingEligible,
  hasVisibleNewsSource,
  isPubliclyVisibleNewsArticle,
};
