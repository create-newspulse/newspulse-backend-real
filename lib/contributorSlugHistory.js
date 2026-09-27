const { canonicalizeSlug, slugifyUnicode } = require('./slug');

function normalizeContributorSlug(value, { maxLength = 140 } = {}) {
  if (typeof value !== 'string') return '';
  return slugifyUnicode(canonicalizeSlug(value.normalize('NFKC')), { maxLength });
}

function normalizeContributorSlugHistory(history, currentSlug) {
  const values = Array.isArray(history) ? history : [];
  return [...new Set([...values, currentSlug].map(value => normalizeContributorSlug(value)).filter(Boolean))];
}

module.exports = { normalizeContributorSlug, normalizeContributorSlugHistory };