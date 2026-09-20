const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const {
  REQUIRED_PUBLIC_NEWS_INDEXES,
  createIndexOptions,
  runPublicNewsIndexCreation,
} = require('../scripts/create-public-news-indexes');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function actualIndexFromDefinition(definition) {
  return {
    name: definition.name,
    key: clone(definition.key),
    ...clone(definition.options || {}),
  };
}

function makeLogger() {
  return {
    lines: [],
    errors: [],
    log(...args) {
      this.lines.push(args.join(' '));
    },
    error(...args) {
      this.errors.push(args.join(' '));
    },
  };
}

function makeMockCollection(initialIndexes = []) {
  const state = {
    indexes: initialIndexes.map(clone),
    createCalls: [],
    dropCalls: [],
    syncCalls: [],
    createIndexesCalls: [],
  };

  const collection = {
    collectionName: 'news',
    async indexes() {
      return state.indexes.map(clone);
    },
    async createIndex(key, options) {
      state.createCalls.push({ key: clone(key), options: clone(options) });
      state.indexes.push({ name: options.name, key: clone(key), ...clone(options) });
      return options.name;
    },
    async dropIndex(name) {
      state.dropCalls.push(name);
      throw new Error('dropIndex must not be called');
    },
    async syncIndexes() {
      state.syncCalls.push(true);
      throw new Error('syncIndexes must not be called');
    },
    async createIndexes(indexes) {
      state.createIndexesCalls.push(indexes);
      throw new Error('createIndexes must not be called');
    },
  };

  return { collection, state };
}

test('public-news index creator dry-run creates nothing', async () => {
  const { collection, state } = makeMockCollection([]);
  const logger = makeLogger();

  const result = await runPublicNewsIndexCreation({
    collection,
    apply: false,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(state.createCalls.length, 0);
  assert.deepEqual(result.finalReport.missing, REQUIRED_PUBLIC_NEWS_INDEXES.map((definition) => definition.name));
  assert.ok(logger.lines.some((line) => line.includes('DRY-RUN')));
});

test('--apply creates only missing public-news indexes', async () => {
  const existing = actualIndexFromDefinition(REQUIRED_PUBLIC_NEWS_INDEXES[0]);
  const { collection, state } = makeMockCollection([existing]);
  const logger = makeLogger();

  const result = await runPublicNewsIndexCreation({
    collection,
    apply: true,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.equal(state.createCalls.length, REQUIRED_PUBLIC_NEWS_INDEXES.length - 1);
  assert.deepEqual(
    state.createCalls.map((call) => call.options.name),
    REQUIRED_PUBLIC_NEWS_INDEXES.slice(1).map((definition) => definition.name)
  );
  assert.deepEqual(result.finalReport.missing, []);
  assert.deepEqual(result.finalReport.mismatched, []);
  assert.equal(result.operations.filter((operation) => operation.status === 'SKIPPED').length, 1);
});

test('existing matching public-news index is skipped', async () => {
  const existing = REQUIRED_PUBLIC_NEWS_INDEXES.map(actualIndexFromDefinition);
  const { collection, state } = makeMockCollection(existing);
  const logger = makeLogger();

  const result = await runPublicNewsIndexCreation({
    collection,
    apply: true,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.equal(state.createCalls.length, 0);
  assert.equal(result.operations.length, REQUIRED_PUBLIC_NEWS_INDEXES.length);
  assert.ok(result.operations.every((operation) => operation.status === 'SKIPPED'));
});

test('conflicting same-name public-news index stops safely', async () => {
  const conflict = {
    name: REQUIRED_PUBLIC_NEWS_INDEXES[0].name,
    key: { status: 1, createdAt: -1 },
  };
  const { collection, state } = makeMockCollection([conflict]);
  const logger = makeLogger();

  await assert.rejects(
    runPublicNewsIndexCreation({
      collection,
      apply: true,
      databaseName: 'test',
      collectionName: 'news',
      logger,
    }),
    (error) => error && error.code === 'PUBLIC_NEWS_INDEX_CONFLICT'
  );

  assert.equal(state.createCalls.length, 0);
  assert.ok(logger.errors.some((line) => line.includes(`CONFLICT ${REQUIRED_PUBLIC_NEWS_INDEXES[0].name}`)));
});

test('category public-news index collation is exact', async () => {
  const categoryDefinition = REQUIRED_PUBLIC_NEWS_INDEXES.find((definition) => definition.name === 'public_news_category_status_published_created_ci');

  assert.ok(categoryDefinition);
  assert.deepEqual(categoryDefinition.options.collation, { locale: 'en', strength: 2 });
  assert.deepEqual(createIndexOptions(categoryDefinition), {
    name: 'public_news_category_status_published_created_ci',
    collation: { locale: 'en', strength: 2 },
  });
});

test('public-news index creator never calls drop or sync index APIs', async () => {
  const { collection, state } = makeMockCollection([]);
  const logger = makeLogger();

  await runPublicNewsIndexCreation({
    collection,
    apply: true,
    databaseName: 'test',
    collectionName: 'news',
    logger,
  });

  assert.equal(state.dropCalls.length, 0);
  assert.equal(state.syncCalls.length, 0);
  assert.equal(state.createIndexesCalls.length, 0);
});