const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  buildAuditReport,
  buildSpecificExampleIndexOverlap,
  findActualNotDeclared,
  findCompoundPrefixOrSubsetCandidates,
  findExactDuplicateKeyPatterns,
  findSingleFieldPrefixCandidates,
  isPrefixKey,
  isSubsetKey,
  summarizeActualIndexes,
  summarizeDeclaredIndexes,
} = require('../scripts/audit-news-index-capacity');

test('index capacity helpers detect exact duplicate key patterns', () => {
  const actualIndexes = summarizeActualIndexes([
    { name: 'status_1', key: { status: 1 } },
    { name: 'status_1_copy', key: { status: 1 } },
    { name: 'status_1_unique', key: { status: 1 }, unique: true },
  ]);

  const duplicates = findExactDuplicateKeyPatterns(actualIndexes);

  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].indexes, ['status_1', 'status_1_copy']);
  assert.deepEqual(duplicates[0].key, { status: 1 });
});

test('index capacity helpers distinguish prefix and subset relationships', () => {
  assert.equal(isPrefixKey({ status: 1 }, { status: 1, createdAt: -1 }), true);
  assert.equal(isPrefixKey({ createdAt: -1 }, { status: 1, createdAt: -1 }), false);
  assert.equal(isSubsetKey({ createdAt: -1 }, { status: 1, createdAt: -1 }), true);
  assert.equal(isSubsetKey({ createdAt: 1 }, { status: 1, createdAt: -1 }), false);
});

test('index capacity helpers flag single-field indexes that prefix compounds', () => {
  const actualIndexes = summarizeActualIndexes([
    { name: 'status_1', key: { status: 1 } },
    { name: 'status_1_createdAt_-1', key: { status: 1, createdAt: -1 } },
    { name: 'createdAt_-1', key: { createdAt: -1 } },
  ]);

  const candidates = findSingleFieldPrefixCandidates(actualIndexes);

  assert.deepEqual(candidates.map((candidate) => candidate.indexName), ['status_1']);
  assert.deepEqual(candidates[0].coveredBy, ['status_1_createdAt_-1']);
});

test('index capacity helpers flag compound prefixes and subsets conservatively', () => {
  const actualIndexes = summarizeActualIndexes([
    { name: 'translationKey_1_lang_1', key: { translationKey: 1, lang: 1 } },
    { name: 'translationKey_1_lang_1_status_1_publishedAt_-1', key: { translationKey: 1, lang: 1, status: 1, publishedAt: -1 } },
    { name: 'lang_1_status_1', key: { lang: 1, status: 1 } },
  ]);

  const candidates = findCompoundPrefixOrSubsetCandidates(actualIndexes);
  const byName = new Map(candidates.map((candidate) => [candidate.indexName, candidate]));

  assert.deepEqual(byName.get('translationKey_1_lang_1').prefixOf, ['translationKey_1_lang_1_status_1_publishedAt_-1']);
  assert.deepEqual(byName.get('lang_1_status_1').subsetOf, ['translationKey_1_lang_1_status_1_publishedAt_-1']);
});

test('index capacity helpers report actual indexes no longer declared by News schema', () => {
  const actualIndexes = summarizeActualIndexes([
    { name: '_id_', key: { _id: 1 } },
    { name: 'legacy_1', key: { legacy: 1 } },
    { name: 'status_1_createdAt_-1', key: { status: 1, createdAt: -1 } },
  ]);
  const declaredIndexes = summarizeDeclaredIndexes([
    [{ status: 1, createdAt: -1 }, {}],
  ]);

  const notDeclared = findActualNotDeclared(actualIndexes, declaredIndexes);

  assert.deepEqual(notDeclared.map((candidate) => candidate.indexName), ['legacy_1']);
});

test('buildAuditReport reports capacity and conservative candidate buckets', () => {
  const actualRawIndexes = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'status_1', key: { status: 1 } },
    { name: 'status_1_createdAt_-1', key: { status: 1, createdAt: -1 } },
    { name: 'legacy_1', key: { legacy: 1 } },
  ];
  const schemaIndexes = [
    [{ status: 1, createdAt: -1 }, {}],
  ];

  const report = buildAuditReport({
    databaseName: 'test',
    collectionName: 'news',
    actualRawIndexes,
    schemaIndexes,
    indexStats: {
      supported: true,
      stats: actualRawIndexes.map((index) => ({ name: index.name, accesses: { ops: 0 } })),
    },
    serverStatus: { supported: true, uptimeSeconds: 100 },
    root: __dirname,
  });

  assert.equal(report.mode, 'read-only');
  assert.equal(report.totalActualIndexCount, 4);
  assert.equal(report.indexCapacityRemaining, 60);
  assert.ok(report.mediumConfidenceCandidatesRequiringReview.some((candidate) => candidate.indexName === 'status_1'));
  assert.ok(report.highConfidencePossibleDropCandidates.some((candidate) => candidate.indexName === 'legacy_1'));
  assert.ok(report.indexesThatMustDefinitelyBeKept.some((index) => index.name === '_id_'));
  assert.ok(report.specificExampleIndexOverlap.some((entry) => entry.name === 'status_1'));
});

test('specific example overlap inspects named production examples', () => {
  const actualIndexes = summarizeActualIndexes([
    { name: 'translationKey_1', key: { translationKey: 1 } },
    { name: 'translationKey_1_lang_1_status_1_publishedAt_-1', key: { translationKey: 1, lang: 1, status: 1, publishedAt: -1 } },
  ]);
  const declaredIndexes = summarizeDeclaredIndexes([
    [{ translationKey: 1, lang: 1, status: 1, publishedAt: -1 }, {}],
  ]);

  const overlap = buildSpecificExampleIndexOverlap({
    actualIndexes,
    declaredIndexes,
    usageByName: new Map([['translationKey_1', { accesses: { ops: 3 } }]]),
    root: __dirname,
  });
  const translationKey = overlap.find((entry) => entry.name === 'translationKey_1');
  const compound = overlap.find((entry) => entry.name === 'translationKey_1_lang_1_status_1_publishedAt_-1');

  assert.equal(translationKey.actualExists, true);
  assert.deepEqual(translationKey.usage, { ops: 3 });
  assert.deepEqual(translationKey.prefixOf, ['translationKey_1_lang_1_status_1_publishedAt_-1']);
  assert.equal(compound.declaredInNewsSchema, true);
});