const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  buildExplainDiagnostics,
  compareDeclaredToActual,
  summarizeExplain,
} = require('../scripts/audit-public-news-indexes');

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

function mockExplain(indexName = 'mock_index') {
  return {
    queryPlanner: {
      winningPlan: {
        stage: 'FETCH',
        inputStage: { stage: 'IXSCAN', indexName },
      },
    },
    executionStats: {
      nReturned: 3,
      executionTimeMillis: 7,
      totalKeysExamined: 5,
      totalDocsExamined: 3,
    },
  };
}

function makeMockCollection() {
  const calls = [];
  const matchedLookupDocs = [
    { translationKey: 'group-a' },
    { translationGroupId: 'group-b' },
    { slug: 'standalone-story', slugs: { en: 'standalone-story' } },
  ];

  function makeCursor(call) {
    return {
      sort(value) {
        call.sort = clone(value);
        return this;
      },
      skip(value) {
        call.skip = value;
        return this;
      },
      limit(value) {
        call.limit = value;
        return this;
      },
      collation(value) {
        call.collation = clone(value);
        return this;
      },
      async explain() {
        return mockExplain(call.op === 'aggregate' ? 'count_index' : 'find_index');
      },
      async toArray() {
        return matchedLookupDocs.map(clone);
      },
    };
  }

  return {
    calls,
    collection: {
      find(filter, options) {
        const call = { op: 'find', filter: clone(filter), options: clone(options || {}) };
        calls.push(call);
        return makeCursor(call);
      },
      aggregate(pipeline, options) {
        const call = { op: 'aggregate', pipeline: clone(pipeline), options: clone(options || {}) };
        calls.push(call);
        return makeCursor(call);
      },
    },
  };
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

test('public-news audit explain summary includes required execution stats', () => {
  const summary = summarizeExplain(mockExplain('public_news_latest_status_published_created'));

  assert.deepEqual(summary.winningIndexNames, ['public_news_latest_status_published_created']);
  assert.equal(summary.hasCollscan, false);
  assert.equal(summary.hasSortStage, false);
  assert.equal(summary.nReturned, 3);
  assert.equal(summary.executionTimeMillis, 7);
  assert.equal(summary.totalKeysExamined, 5);
  assert.equal(summary.totalDocsExamined, 3);
});

test('public-news audit explain diagnostics labels individual find count and sibling operations', async () => {
  const { collection, calls } = makeMockCollection();

  const explain = await buildExplainDiagnostics({
    collection,
    args: { explain: true, lang: 'gu', category: 'national', limit: 30, page: 1 },
  });

  assert.deepEqual(explain.map((entry) => entry.label), [
    'latest.find:gu',
    'latest.count:gu',
    'category.matched.find:national',
    'category.matched.count:national',
    'category.siblings.find:national',
  ]);
  assert.deepEqual(explain.map((entry) => entry.operation), [
    'find',
    'countDocuments',
    'find',
    'countDocuments',
    'find',
  ]);
  assert.equal(explain[3].productionOperation, false);
  assert.deepEqual(explain[4].siblingLookupMetadata, {
    matchedLookupCount: 3,
    groupKeyCount: 2,
    canonicalSlugCount: 1,
    siblingClauseCount: 4,
  });
  assert.equal(calls.filter((call) => call.op === 'aggregate').length, 2);
  assert.equal(calls.some((call) => call.op === 'find' && call.options?.projection?._id === 0), true);
});