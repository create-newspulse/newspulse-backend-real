const News = require('../models/News');
const { normalizeLanguage } = require('../middleware/lang');

function getArticleTranslationGroupKey(docLike) {
  return String(docLike?.translationGroupId || docLike?.translationKey || '').trim();
}

function getArticleEffectiveLanguage(docLike) {
  return normalizeLanguage(docLike?.language)
    || normalizeLanguage(docLike?.lang)
    || normalizeLanguage(docLike?.originalLang)
    || null;
}

async function assertTranslationGroupLanguageUnique(groupId, lang, excludeId) {
  const groupKey = String(groupId || '').trim();
  const langNorm = normalizeLanguage(lang);
  if (!groupKey || !langNorm) return;

  const q = {
    $and: [
      { $or: [{ translationGroupId: groupKey }, { translationKey: groupKey }] },
      { $or: [{ language: langNorm }, { lang: langNorm }] },
      { status: { $ne: 'deleted' } },
    ],
  };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await News.findOne(q).select('_id translationGroupId translationKey language lang').lean();
  if (existing) {
    const err = new Error('An article for this translationGroupId and language already exists');
    err.status = 409;
    throw err;
  }
}

async function assertArticleTranslationGroupLanguageUnique(docLike, excludeId) {
  await assertTranslationGroupLanguageUnique(
    getArticleTranslationGroupKey(docLike),
    getArticleEffectiveLanguage(docLike),
    excludeId || docLike?._id
  );
}

module.exports = {
  assertArticleTranslationGroupLanguageUnique,
  assertTranslationGroupLanguageUnique,
  getArticleEffectiveLanguage,
  getArticleTranslationGroupKey,
};
