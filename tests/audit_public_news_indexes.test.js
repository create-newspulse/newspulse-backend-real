const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { compareDeclaredToActual } = require('../scripts/audit-public-news-indexes');

const MONGODB_EXPANDED_EN_STRENGTH_2_COLLATION = Object.freeze({
  locale: 'en',
  caseLevel: false,
  caseFirst: 'off',
  strength: 2,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
  version: '57.1',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('public-news audit treats MongoDB-expanded collation as matching expected fields', () => {
  const [status] = compareDeclaredToActual([
    {
      name: 'public_news_category_status_published_created_ci',
      key: { category: 1, status: 1, publishedAt: -1, createdAt: -1 },
      options: { collation: { locale: 'en', strength: 2 } },
    },
  ], [
    {
      name: 'public_news_category_status_published_created_ci',
      key: { category: 1, status: 1, publishedAt: -1, createdAt: -1 },
      options: { collation: clone(MONGODB_EXPANDED_EN_STRENGTH_2_COLLATION) },
    },
  ]);

  assert.equal(status.exists, true);
  assert.equal(status.keyMatches, true);
  assert.equal(status.collationMatches, true);
  assert.equal(status.matches, true);
});

test('public-news audit still rejects key-order mismatch with expanded collation', () => {
  const [status] = compareDeclaredToActual([
    {
      name: 'public_news_category_status_published_created_ci',
      key: { category: 1, status: 1, publishedAt: -1, createdAt: -1 },
      options: { collation: { locale: 'en', strength: 2 } },
    },
  ], [
    {
      name: 'public_news_category_status_published_created_ci',
      key: { status: 1, category: 1, publishedAt: -1, createdAt: -1 },
      options: { collation: clone(MONGODB_EXPANDED_EN_STRENGTH_2_COLLATION) },
    },
  ]);

  assert.equal(status.exists, true);
  assert.equal(status.keyMatches, false);
  assert.equal(status.collationMatches, true);
  assert.equal(status.matches, false);
});