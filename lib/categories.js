const SCIENCE_TECH_MATCH_VALUES = Object.freeze([
  'tech',
  'science-technology',
  'science-and-technology',
  'sci-tech',
  'science_and_technology',
]);

const PUBLIC_CATEGORY_DEFINITIONS = Object.freeze({
  tech: Object.freeze({
    key: 'tech',
    label: 'Science & Technology',
    publicSlug: 'science-technology',
    matchValues: SCIENCE_TECH_MATCH_VALUES,
  }),
});

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCategoryLookupValue(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-');
}

function getCanonicalPublicCategoryKey(value) {
  const normalized = normalizeCategoryLookupValue(value);
  if (!normalized) return null;

  if (SCIENCE_TECH_MATCH_VALUES.includes(normalized)) {
    return 'tech';
  }

  return normalized;
}

function getPublicCategoryDefinition(value) {
  const key = getCanonicalPublicCategoryKey(value);
  if (!key) return null;
  return PUBLIC_CATEGORY_DEFINITIONS[key] || null;
}

function isSupportedPublicCategory(value, allowedValues) {
  const key = getCanonicalPublicCategoryKey(value);
  if (!key) return false;
  if (!Array.isArray(allowedValues) || allowedValues.length === 0) return true;
  return allowedValues.includes(key);
}

function buildPublicCategoryFilter(value) {
  const key = getCanonicalPublicCategoryKey(value);
  if (!key) return null;

  const definition = PUBLIC_CATEGORY_DEFINITIONS[key];
  const matchValues = definition && Array.isArray(definition.matchValues) && definition.matchValues.length
    ? definition.matchValues
    : [key];

  return new RegExp(`^(?:${matchValues.map(escapeRegExp).join('|')})$`, 'i');
}

module.exports = {
  PUBLIC_CATEGORY_DEFINITIONS,
  getCanonicalPublicCategoryKey,
  getPublicCategoryDefinition,
  isSupportedPublicCategory,
  buildPublicCategoryFilter,
};