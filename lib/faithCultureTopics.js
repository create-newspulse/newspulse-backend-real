const { isDeepStrictEqual } = require('node:util');

const FAITH_TOPIC_CODES = Object.freeze([
  'faith-spiritual-life',
  'living-heritage',
  'food-agricultural-heritage',
  'architecture-art-public-heritage',
  'community-social-traditions',
  'folk-arts-festivals-textiles',
  'language-cultural-identity',
]);

function isFaithCultureCategory(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'faith-culture';
}

function buildFaithTopicPatch({ category, existingCategory, topic, topicProvided }) {
  const wasFaith = isFaithCultureCategory(existingCategory);
  const willBeFaith = isFaithCultureCategory(category === undefined ? existingCategory : category);
  if (!willBeFaith) return { ok: true, value: wasFaith ? null : undefined };
  if (!topicProvided) {
    return { ok: true, value: existingCategory !== undefined && !wasFaith ? null : undefined };
  }
  if (topic === null) return { ok: true, value: null };
  if (typeof topic !== 'string') return { ok: false, message: 'Invalid Faith & Culture topic' };
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return { ok: true, value: null };
  if (!FAITH_TOPIC_CODES.includes(normalized)) return { ok: false, message: 'Invalid Faith & Culture topic' };
  return { ok: true, value: normalized };
}

function isFaithTopicOnlyUpdate(before, update, { ignoreLanguageRepair = false } = {}) {
  if (!isFaithCultureCategory(before?.category) || !Object.prototype.hasOwnProperty.call(update, 'topic')) return false;
  const jsonValue = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return Object.entries(update).every(([key, value]) => {
    if (key === 'topic') return true;
    if (key === 'category' && isFaithCultureCategory(value)) return true;
    if (ignoreLanguageRepair && ['lang', 'language', 'originalLang'].includes(key)) return true;
    const previous = key.split('.').reduce((object, part) => object?.[part], before);
    return isDeepStrictEqual(jsonValue(previous), jsonValue(value));
  });
}

module.exports = { FAITH_TOPIC_CODES, isFaithCultureCategory, buildFaithTopicPatch, isFaithTopicOnlyUpdate };
