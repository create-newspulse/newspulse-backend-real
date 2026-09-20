const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  SOURCE_INDEXES,
  TARGET_INDEXES,
  createIndexOptions,
  indexStatus,
  runPriorityIndexSwap,
} = require('../scripts/swap-public-news-priority-indexes');

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

function indexDoc(definition) {
  return {
    name: definition.name,
    key: clone(definition.key),
    ...clone(definition.options || {}),
  };
}

function initialSourceIndexes() {
  return SOURCE_INDEXES.map(indexDoc);
}

function makeLogger() {
  return {
    lines: [],
    log(...args) {
      this.lines.push(args.join(' '));
    },
    error(...args) {
      this.lines.push(args.join(' '));
    },
  };
}

function makeMockCollection(initialIndexes, options = {}) {
  const state = {
    indexes: initialIndexes.map(clone),
    calls: [],
    failCreateName: options.failCreateName || null,
  };

  const collection = {
    collectionName: 'news',
    async indexes() {
      state.calls.push({ op: 'indexes' });
      return state.indexes.map(clone);
    },
    async dropIndex(name) {
      state.calls.push({ op: 'dropIndex', name });
      state.indexes = state.indexes.filter((index) => index.name !== name);
      return { ok: 1 };
    },
    async createIndex(key, createOptions) {
      state.calls.push({ op: 'createIndex', key: clone(key), options: clone(createOptions) });
      if (state.failCreateName && createOptions.name === state.failCreateName) {
        throw new Error(`create failed: ${createOptions.name}`);
      }
      state.indexes.push({ name: createOptions.name, key: clone(key), ...clone(createOptions) });
      return createOptions.name;
    },
    async syncIndexes() {
      state.calls.push({ op: 'syncIndexes' });
      throw new Error('syncIndexes must not be called');
    },
    async createIndexes(indexes) {
      state.calls.push({ op: 'createIndexes', indexes });
      throw new Error('createIndexes must not be called');
    },
  };

  return { collection, state };
}

function mutationCalls(state) {
  return state.calls.filter((call) => call.op === 'dropIndex' || call.op === 'createIndex');
}

test('priority index swap dry-run makes zero mutations', async () => {
  const { collection, state } = makeMockCollection(initialSourceIndexes());
  const logger = makeLogger();

  const result = await runPriorityIndexSwap({
    collection,
    apply: false,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(mutationCalls(state).length, 0);
  assert.ok(logger.lines.some((line) => line.includes('DRY-RUN')));
});

test('priority index swap bad source key stops before mutation', async () => {
  const badSources = initialSourceIndexes();
  badSources[0].key = { originRole: -1 };
  const { collection, state } = makeMockCollection(badSources);

  await assert.rejects(
    runPriorityIndexSwap({ collection, apply: true, databaseName: 'test', collectionName: 'news', logger: makeLogger() }),
    (error) => error && error.code === 'PUBLIC_NEWS_PRIORITY_SWAP_PRECHECK_FAILED'
  );

  assert.equal(mutationCalls(state).length, 0);
});

test('priority index swap target-name conflict stops before mutation', async () => {
  const indexes = [
    ...initialSourceIndexes(),
    { name: TARGET_INDEXES[0].name, key: { status: 1, createdAt: -1 } },
  ];
  const { collection, state } = makeMockCollection(indexes);

  await assert.rejects(
    runPriorityIndexSwap({ collection, apply: true, databaseName: 'test', collectionName: 'news', logger: makeLogger() }),
    (error) => error && error.code === 'PUBLIC_NEWS_PRIORITY_SWAP_PRECHECK_FAILED'
  );

  assert.equal(mutationCalls(state).length, 0);
});

test('priority index swap first swap completes before second drop begins', async () => {
  const { collection, state } = makeMockCollection(initialSourceIndexes());
  const logger = makeLogger();

  const result = await runPriorityIndexSwap({
    collection,
    apply: true,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.deepEqual(mutationCalls(state).map((call) => `${call.op}:${call.name || call.options.name}`), [
    'dropIndex:originRole_1',
    `createIndex:${TARGET_INDEXES[0].name}`,
    'dropIndex:contentKind_1',
    `createIndex:${TARGET_INDEXES[1].name}`,
  ]);
  assert.deepEqual(result.operations, [
    'drop:originRole_1',
    `create:${TARGET_INDEXES[0].name}`,
    `verify:${TARGET_INDEXES[0].name}`,
    'drop:contentKind_1',
    `create:${TARGET_INDEXES[1].name}`,
    `verify:${TARGET_INDEXES[1].name}`,
  ]);
  assert.ok(logger.lines.some((line) => line.includes('FINAL REPORT')));
});

test('failure creating latest prevents contentKind_1 from being dropped', async () => {
  const { collection, state } = makeMockCollection(initialSourceIndexes(), { failCreateName: TARGET_INDEXES[0].name });

  await assert.rejects(
    runPriorityIndexSwap({ collection, apply: true, databaseName: 'test', collectionName: 'news', logger: makeLogger() }),
    /create failed/
  );

  assert.deepEqual(mutationCalls(state).map((call) => `${call.op}:${call.name || call.options.name}`), [
    'dropIndex:originRole_1',
    `createIndex:${TARGET_INDEXES[0].name}`,
  ]);
  assert.equal(state.indexes.some((index) => index.name === 'contentKind_1'), true);
});

test('priority index swap category collation is exact', () => {
  assert.deepEqual(TARGET_INDEXES[1].options.collation, { locale: 'en', strength: 2 });
  assert.deepEqual(createIndexOptions(TARGET_INDEXES[1]), {
    name: 'public_news_category_status_published_created_ci',
    collation: { locale: 'en', strength: 2 },
  });
});

test('priority index swap verifier matches MongoDB-expanded category collation', () => {
  const status = indexStatus(TARGET_INDEXES[1], [{
    name: TARGET_INDEXES[1].name,
    key: clone(TARGET_INDEXES[1].key),
    collation: clone(MONGODB_EXPANDED_EN_STRENGTH_2_COLLATION),
  }]);

  assert.equal(status.exists, true);
  assert.equal(status.keyMatches, true);
  assert.equal(status.collationMatches, true);
  assert.equal(status.matches, true);
});

test('priority index swap verifier still rejects key-order mismatch with expanded collation', () => {
  const status = indexStatus(TARGET_INDEXES[1], [{
    name: TARGET_INDEXES[1].name,
    key: { status: 1, category: 1, publishedAt: -1, createdAt: -1 },
    collation: clone(MONGODB_EXPANDED_EN_STRENGTH_2_COLLATION),
  }]);

  assert.equal(status.exists, true);
  assert.equal(status.keyMatches, false);
  assert.equal(status.collationMatches, true);
  assert.equal(status.matches, false);
});

test('priority index swap only uses approved dropIndex names', async () => {
  const { collection, state } = makeMockCollection(initialSourceIndexes());

  await runPriorityIndexSwap({ collection, apply: true, databaseName: 'test', collectionName: 'news', logger: makeLogger() });

  assert.deepEqual(
    state.calls.filter((call) => call.op === 'dropIndex').map((call) => call.name),
    ['originRole_1', 'contentKind_1']
  );
});

test('priority index swap only uses approved createIndex definitions', async () => {
  const { collection, state } = makeMockCollection(initialSourceIndexes());

  await runPriorityIndexSwap({ collection, apply: true, databaseName: 'test', collectionName: 'news', logger: makeLogger() });

  assert.deepEqual(
    state.calls.filter((call) => call.op === 'createIndex').map((call) => ({ key: call.key, options: call.options })),
    TARGET_INDEXES.map((target) => ({ key: clone(target.key), options: createIndexOptions(target) }))
  );
});