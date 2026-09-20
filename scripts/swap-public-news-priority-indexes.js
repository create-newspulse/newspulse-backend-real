const path = require('path');

const nodeEnvEarly = String(process.env.NODE_ENV || 'development').toLowerCase();
const isRenderEarly = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
const isProdEarly = nodeEnvEarly === 'production' || isRenderEarly;

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  override: !isProdEarly && nodeEnvEarly !== 'test',
});

// Match server.js startup compatibility: prefer MONGODB_URI, but allow legacy MONGO_URI.
if (!process.env.MONGODB_URI && process.env.MONGO_URI) {
  process.env.MONGODB_URI = process.env.MONGO_URI;
}

const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const News = require('../models/News');

const SOURCE_INDEXES = Object.freeze([
  Object.freeze({ name: 'originRole_1', key: Object.freeze({ originRole: 1 }) }),
  Object.freeze({ name: 'contentKind_1', key: Object.freeze({ contentKind: 1 }) }),
]);

const TARGET_INDEXES = Object.freeze([
  Object.freeze({
    name: 'public_news_latest_status_published_created',
    key: Object.freeze({ status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({}),
  }),
  Object.freeze({
    name: 'public_news_category_status_published_created_ci',
    key: Object.freeze({ category: 1, status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({ collation: Object.freeze({ locale: 'en', strength: 2 }) }),
  }),
]);

const ALLOWED_DROP_INDEX_NAMES = Object.freeze(new Set(SOURCE_INDEXES.map((index) => index.name)));
const ALLOWED_CREATE_INDEX_NAMES = Object.freeze(new Set(TARGET_INDEXES.map((index) => index.name)));
const SIGNIFICANT_INDEX_OPTION_KEYS = Object.freeze([
  'collation',
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',
  '2dsphereIndexVersion',
  'bits',
  'min',
  'max',
  'bucketSize',
  'wildcardProjection',
]);

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function significantIndexOptions(indexLike = {}) {
  const options = {};
  for (const key of SIGNIFICANT_INDEX_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(indexLike, key)) options[key] = indexLike[key];
  }
  return options;
}

function collationContainsExpected(actualCollation, expectedCollation) {
  if (!expectedCollation) return !actualCollation;
  if (!actualCollation || typeof actualCollation !== 'object') return false;

  return Object.entries(expectedCollation).every(([key, expectedValue]) => (
    stableStringify(actualCollation[key]) === stableStringify(expectedValue)
  ));
}

function indexOptionsMatchExpected(actualOptions = {}, expectedOptions = {}) {
  const { collation: actualCollation, ...actualWithoutCollation } = actualOptions || {};
  const { collation: expectedCollation, ...expectedWithoutCollation } = expectedOptions || {};

  return stableStringify(actualWithoutCollation) === stableStringify(expectedWithoutCollation)
    && collationContainsExpected(actualCollation || null, expectedCollation || null);
}

function indexKeyMatchesExpected(actualKey, expectedKey) {
  if (!actualKey || !expectedKey || typeof actualKey !== 'object' || typeof expectedKey !== 'object') return false;
  const actualEntries = Object.entries(actualKey);
  const expectedEntries = Object.entries(expectedKey);
  if (actualEntries.length !== expectedEntries.length) return false;

  return expectedEntries.every(([expectedField, expectedValue], index) => {
    const [actualField, actualValue] = actualEntries[index] || [];
    return actualField === expectedField && stableStringify(actualValue) === stableStringify(expectedValue);
  });
}

function findIndexByName(indexes, name) {
  return (Array.isArray(indexes) ? indexes : []).find((index) => index && index.name === name) || null;
}

function createIndexOptions(definition) {
  return {
    name: definition.name,
    ...(definition.options || {}),
  };
}

function indexMatchesDefinition(actual, definition) {
  if (!actual) return false;
  const expectedOptions = significantIndexOptions(definition.options || {});
  const actualOptions = significantIndexOptions(actual);
  return indexKeyMatchesExpected(actual.key || {}, definition.key)
    && indexOptionsMatchExpected(actualOptions, expectedOptions);
}

function indexStatus(definition, indexes) {
  const actual = findIndexByName(indexes, definition.name);
  const expectedOptions = significantIndexOptions(definition.options || {});
  const actualOptions = actual ? significantIndexOptions(actual) : {};
  const expectedCollation = expectedOptions.collation || null;
  const actualCollation = actualOptions.collation || null;
  const keyMatches = actual ? indexKeyMatchesExpected(actual.key || {}, definition.key) : false;
  const optionsMatches = actual ? indexOptionsMatchExpected(actualOptions, expectedOptions) : false;
  const collationMatches = actual ? collationContainsExpected(actualCollation, expectedCollation) : false;

  return {
    name: definition.name,
    expectedKey: definition.key,
    actualKey: actual ? actual.key || null : null,
    exists: Boolean(actual),
    keyMatches,
    optionsMatches,
    collationMatches,
    matches: Boolean(actual && keyMatches && optionsMatches),
  };
}

function sourceStatus(source, indexes) {
  const actual = findIndexByName(indexes, source.name);
  const keyMatches = actual ? indexKeyMatchesExpected(actual.key || {}, source.key) : false;
  return {
    name: source.name,
    expectedKey: source.key,
    actualKey: actual ? actual.key || null : null,
    exists: Boolean(actual),
    keyMatches,
  };
}

function buildPrecheck({ indexes, databaseName, collectionName }) {
  const sourceIndexes = SOURCE_INDEXES.map((source) => sourceStatus(source, indexes));
  const targetIndexes = TARGET_INDEXES.map((target) => indexStatus(target, indexes));
  const errors = [];

  if (!databaseName || !collectionName) errors.push('database/collection could not be resolved');

  for (const source of sourceIndexes) {
    if (!source.exists) errors.push(`source index missing: ${source.name}`);
    else if (!source.keyMatches) errors.push(`source index key mismatch: ${source.name}`);
  }

  for (const target of targetIndexes) {
    if (target.exists && !target.matches) errors.push(`target same-name conflict: ${target.name}`);
    if (target.exists && target.matches) errors.push(`target already exists: ${target.name}`);
  }

  return {
    databaseName: databaseName || null,
    collectionName: collectionName || null,
    currentTotalIndexCount: Array.isArray(indexes) ? indexes.length : 0,
    sourceIndexes,
    targetIndexes,
    plannedOperations: [
      `drop ${SOURCE_INDEXES[0].name}`,
      `create ${TARGET_INDEXES[0].name}`,
      `verify ${TARGET_INDEXES[0].name}`,
      `drop ${SOURCE_INDEXES[1].name}`,
      `create ${TARGET_INDEXES[1].name}`,
      `verify ${TARGET_INDEXES[1].name}`,
    ],
    ok: errors.length === 0,
    errors,
  };
}

function finalReport({ indexes, initialTotalIndexCount, databaseName, collectionName }) {
  const latest = indexStatus(TARGET_INDEXES[0], indexes);
  const category = indexStatus(TARGET_INDEXES[1], indexes);
  return {
    databaseName: databaseName || null,
    collectionName: collectionName || null,
    initialTotalIndexCount,
    finalTotalIndexCount: Array.isArray(indexes) ? indexes.length : 0,
    expectedTotalIndexCountUnchanged: initialTotalIndexCount === (Array.isArray(indexes) ? indexes.length : 0),
    originRole_1: { exists: Boolean(findIndexByName(indexes, 'originRole_1')) },
    contentKind_1: { exists: Boolean(findIndexByName(indexes, 'contentKind_1')) },
    latestTarget: {
      exists: latest.exists,
      matches: latest.matches,
    },
    categoryTarget: {
      exists: category.exists,
      matches: category.matches,
      collationMatches: category.collationMatches,
    },
  };
}

function logState(logger, state, detail) {
  if (detail) logger.log(`${state} ${detail}`);
  else logger.log(state);
}

function stopWithPrecheck(precheck, logger) {
  logState(logger, 'STOPPED', precheck.errors.join('; '));
  const error = new Error(`Precheck failed: ${precheck.errors.join('; ')}`);
  error.code = 'PUBLIC_NEWS_PRIORITY_SWAP_PRECHECK_FAILED';
  error.precheck = precheck;
  throw error;
}

function assertAllowedDropName(name) {
  if (!ALLOWED_DROP_INDEX_NAMES.has(name)) {
    const error = new Error(`Refusing to drop unapproved index: ${name}`);
    error.code = 'UNAPPROVED_DROP_INDEX';
    throw error;
  }
}

function assertAllowedCreateDefinition(definition) {
  if (!ALLOWED_CREATE_INDEX_NAMES.has(definition.name)) {
    const error = new Error(`Refusing to create unapproved index: ${definition.name}`);
    error.code = 'UNAPPROVED_CREATE_INDEX';
    throw error;
  }
  const approved = TARGET_INDEXES.find((index) => index.name === definition.name);
  if (!approved || stableStringify(approved.key) !== stableStringify(definition.key) || stableStringify(approved.options || {}) !== stableStringify(definition.options || {})) {
    const error = new Error(`Refusing to create index with unapproved definition: ${definition.name}`);
    error.code = 'UNAPPROVED_CREATE_INDEX_DEFINITION';
    throw error;
  }
}

async function dropSourceIndex(collection, source, logger) {
  assertAllowedDropName(source.name);
  logState(logger, 'DROP START', source.name);
  await collection.dropIndex(source.name);
  logState(logger, 'DROPPED', source.name);
}

async function createTargetIndex(collection, target, logger) {
  assertAllowedCreateDefinition(target);
  logState(logger, 'CREATE START', target.name);
  await collection.createIndex(target.key, createIndexOptions(target));
  logState(logger, 'CREATED', target.name);
}

async function verifyTargetIndex(collection, target, logger) {
  const indexes = await collection.indexes();
  const status = indexStatus(target, indexes);
  if (!status.matches) {
    const error = new Error(`Target index verification failed: ${target.name}`);
    error.code = 'PUBLIC_NEWS_PRIORITY_SWAP_VERIFY_FAILED';
    error.status = status;
    throw error;
  }
  logState(logger, 'VERIFIED', target.name);
}

async function runPriorityIndexSwap({ collection, apply = false, databaseName, collectionName, logger = console } = {}) {
  if (!collection || typeof collection.indexes !== 'function') throw new Error('A Mongo collection with indexes() is required');

  const initialIndexes = await collection.indexes();
  const precheck = buildPrecheck({ indexes: initialIndexes, databaseName, collectionName });
  logState(logger, 'PRECHECK', JSON.stringify(precheck, null, 2));

  if (!precheck.ok) stopWithPrecheck(precheck, logger);

  if (!apply) {
    logger.log('DRY-RUN: no indexes were dropped or created. Re-run with --apply to perform the guarded swap.');
    return { mode: 'dry-run', precheck, operations: [], finalReport: null };
  }

  if (typeof collection.dropIndex !== 'function' || typeof collection.createIndex !== 'function') {
    throw new Error('A Mongo collection with dropIndex() and createIndex() is required when --apply is used');
  }

  const operations = [];
  try {
    await dropSourceIndex(collection, SOURCE_INDEXES[0], logger);
    operations.push(`drop:${SOURCE_INDEXES[0].name}`);
    await createTargetIndex(collection, TARGET_INDEXES[0], logger);
    operations.push(`create:${TARGET_INDEXES[0].name}`);
    await verifyTargetIndex(collection, TARGET_INDEXES[0], logger);
    operations.push(`verify:${TARGET_INDEXES[0].name}`);

    await dropSourceIndex(collection, SOURCE_INDEXES[1], logger);
    operations.push(`drop:${SOURCE_INDEXES[1].name}`);
    await createTargetIndex(collection, TARGET_INDEXES[1], logger);
    operations.push(`create:${TARGET_INDEXES[1].name}`);
    await verifyTargetIndex(collection, TARGET_INDEXES[1], logger);
    operations.push(`verify:${TARGET_INDEXES[1].name}`);
  } catch (error) {
    logState(logger, 'FAILED', error?.message || String(error));
    error.operations = operations;
    throw error;
  }

  const indexes = await collection.indexes();
  const report = finalReport({
    indexes,
    initialTotalIndexCount: precheck.currentTotalIndexCount,
    databaseName,
    collectionName,
  });
  logState(logger, 'FINAL REPORT', JSON.stringify(report, null, 2));
  return { mode: 'apply', precheck, operations, finalReport: report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DBNAME || '').trim() || undefined;

  if (!uri) throw new Error('Missing MONGODB_URI or legacy MONGO_URI');

  await mongoose.connect(uri, {
    ...(dbName ? { dbName } : {}),
    autoIndex: false,
    autoCreate: false,
  });

  const collection = News.collection;
  await runPriorityIndexSwap({
    collection,
    apply: args.apply,
    databaseName: mongoose.connection.name,
    collectionName: collection.collectionName,
    logger: console,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }).finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
}

module.exports = {
  SOURCE_INDEXES,
  TARGET_INDEXES,
  buildPrecheck,
  collationContainsExpected,
  createIndexOptions,
  finalReport,
  indexKeyMatchesExpected,
  indexStatus,
  indexOptionsMatchExpected,
  runPriorityIndexSwap,
};