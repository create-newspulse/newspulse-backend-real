const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  buildExplainDiagnostics,
  compareDeclaredToActual,
  SIBLING_PREPARE_PROJECTION,
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

function bsonError(message = 'Invalid UTF-8 string in BSON document') {
  const error = new Error(message);
  error.name = 'BSONError';
  return error;
}

function makeMockCollection(options = {}) {
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
        if (Array.isArray(options.failExplainCallIndexes) && options.failExplainCallIndexes.includes(call.index)) {
          throw bsonError('Invalid UTF-8 string in BSON document private-title-fragment');
        }
        return mockExplain(call.op === 'aggregate' ? 'count_index' : 'find_index');
      },
      async toArray() {
        if (options.failSiblingPrepare && call.options && call.options.projection && call.options.projection.translationKey === 1 && call.options.projection['slugs.en'] === 1) {
          throw bsonError('Invalid UTF-8 string in BSON document article-content-fragment');
        }
        return matchedLookupDocs.map(clone);
      },
    };
  }

  return {
    calls,
    collection: {
      find(filter, options) {
        const call = { index: calls.length, op: 'find', filter: clone(filter), options: clone(options || {}) };
        calls.push(call);
        return makeCursor(call);
      },
      aggregate(pipeline, options) {
        const call = { index: calls.length, op: 'aggregate', pipeline: clone(pipeline), options: clone(options || {}) };
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
    'category.siblings.prepare',
    'category.siblings.find:national',
  ]);
  assert.deepEqual(explain.map((entry) => entry.operation), [
    'find',
    'countDocuments',
    'find',
    'countDocuments',
    'find',
    'find',
  ]);
  assert.equal(explain[3].productionOperation, false);
  assert.deepEqual(explain[4].projectionFields, ['translationKey', 'translationGroupId', 'slug', 'slugs.en']);
  assert.deepEqual(explain[5].siblingLookupMetadata, {
    matchedLookupCount: 3,
    groupKeyCount: 2,
    canonicalSlugCount: 1,
    siblingClauseCount: 4,
  });
  assert.equal(calls.filter((call) => call.op === 'aggregate').length, 2);
  assert.equal(calls.some((call) => call.op === 'find' && call.options?.projection?._id === 0), true);
});

test('public-news audit explain diagnostics isolate one failed explain section', async () => {
  const { collection } = makeMockCollection({ failExplainCallIndexes: [2] });

  const explain = await buildExplainDiagnostics({
    collection,
    args: { explain: true, lang: 'gu', category: 'national', limit: 30, page: 1 },
  });

  const failed = explain.find((entry) => entry.label === 'category.matched.find:national');
  const latest = explain.find((entry) => entry.label === 'latest.find:gu');
  const sibling = explain.find((entry) => entry.label === 'category.siblings.find:national');

  assert.equal(failed.ok, false);
  assert.equal(failed.errorName, 'BSONError');
  assert.equal(failed.errorMessage, 'Invalid UTF-8 string in BSON document');
  assert.equal(JSON.stringify(failed).includes('private-title-fragment'), false);
  assert.ok(latest.summary);
  assert.ok(sibling.summary);
});

test('public-news audit explain diagnostics report BSON sibling preparation safely', async () => {
  const { collection, calls } = makeMockCollection({ failSiblingPrepare: true });

  const explain = await buildExplainDiagnostics({
    collection,
    args: { explain: true, lang: 'gu', category: 'national', limit: 30, page: 1 },
  });

  const prepare = explain.find((entry) => entry.label === 'category.siblings.prepare');
  const fieldGroups = explain.filter((entry) => String(entry.label || '').startsWith('category.siblings.prepare.'));
  const siblingFind = explain.find((entry) => entry.label === 'category.siblings.find:national');

  assert.equal(prepare.ok, false);
  assert.equal(prepare.errorName, 'BSONError');
  assert.equal(prepare.errorMessage, 'Invalid UTF-8 string in BSON document');
  assert.equal(JSON.stringify(explain).includes('article-content-fragment'), false);
  assert.deepEqual(fieldGroups.map((entry) => entry.label), [
    'category.siblings.prepare.translationKeys',
    'category.siblings.prepare.slug',
    'category.siblings.prepare.slugsEn',
  ]);
  assert.equal(siblingFind.skipped, true);
  assert.equal(siblingFind.reason, 'sibling preparation failed');
  assert.deepEqual(
    calls.find((call) => call.options?.projection?.translationKey === 1 && call.options?.projection?.['slugs.en'] === 1).options.projection,
    SIBLING_PREPARE_PROJECTION
  );
});

test('public-news audit sibling preparation uses minimal lookup projection only', async () => {
  const { collection, calls } = makeMockCollection();

  await buildExplainDiagnostics({
    collection,
    args: { explain: true, lang: 'gu', category: 'national', limit: 30, page: 1 },
  });

  const prepareCall = calls.find((call) => call.options?.projection?.translationKey === 1 && call.options?.projection?.['slugs.en'] === 1);
  assert.deepEqual(prepareCall.options.projection, {
    _id: 0,
    translationKey: 1,
    translationGroupId: 1,
    slug: 1,
    'slugs.en': 1,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(prepareCall.options.projection, 'slugs'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(prepareCall.options.projection, 'title'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(prepareCall.options.projection, 'content'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(prepareCall.options.projection, 'translations'), false);
});