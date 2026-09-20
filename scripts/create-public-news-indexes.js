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

const REQUIRED_PUBLIC_NEWS_INDEXES = Object.freeze([
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
  Object.freeze({
    name: 'public_news_sibling_translation_key_status_published_created',
    key: Object.freeze({ translationKey: 1, status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({}),
  }),
  Object.freeze({
    name: 'public_news_sibling_translation_group_status_published_created',
    key: Object.freeze({ translationGroupId: 1, status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({}),
  }),
  Object.freeze({
    name: 'public_news_sibling_slug_status_published_created',
    key: Object.freeze({ slug: 1, status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({}),
  }),
  Object.freeze({
    name: 'public_news_sibling_slugs_en_status_published_created',
    key: Object.freeze({ 'slugs.en': 1, status: 1, publishedAt: -1, createdAt: -1 }),
    options: Object.freeze({}),
  }),
]);

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
    if (Object.prototype.hasOwnProperty.call(indexLike, key)) {
      options[key] = indexLike[key];
    }
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

function createIndexOptions(definition) {
  return {
    name: definition.name,
    ...(definition.options || {}),
  };
}

function findActualIndexByName(actualIndexes, name) {
  return (Array.isArray(actualIndexes) ? actualIndexes : []).find((index) => index && index.name === name) || null;
}

function getIndexStatus(definition, actualIndexes) {
  const actual = findActualIndexByName(actualIndexes, definition.name);
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
    expectedOptions,
    actualOptions: actual ? actualOptions : null,
    exists: Boolean(actual),
    keyMatches,
    optionsMatches,
    collationMatches,
    matches: Boolean(actual && keyMatches && optionsMatches),
    conflict: Boolean(actual && (!keyMatches || !optionsMatches)),
  };
}

function summarizeRequiredIndexes(actualIndexes) {
  const required = REQUIRED_PUBLIC_NEWS_INDEXES.map((definition) => getIndexStatus(definition, actualIndexes));
  return {
    required,
    existing: required.filter((index) => index.exists).map((index) => index.name),
    missing: required.filter((index) => !index.exists).map((index) => index.name),
    conflicts: required.filter((index) => index.conflict).map((index) => index.name),
    mismatched: required.filter((index) => index.exists && !index.matches).map((index) => index.name),
  };
}

function logReport({ logger, mode, databaseName, collectionName, report }) {
  logger.log(JSON.stringify({
    mode,
    databaseName,
    collectionName,
    existingRequiredIndexes: report.existing,
    missingRequiredIndexes: report.missing,
    conflictingRequiredIndexes: report.conflicts,
    requiredPublicNewsIndexes: report.required,
  }, null, 2));
}

async function runPublicNewsIndexCreation({ collection, apply = false, databaseName, collectionName, logger = console } = {}) {
  if (!collection || typeof collection.indexes !== 'function') {
    throw new Error('A Mongo collection with indexes() is required');
  }

  const initialIndexes = await collection.indexes();
  const initialReport = summarizeRequiredIndexes(initialIndexes);
  const mode = apply ? 'apply' : 'dry-run';
  const resolvedDatabaseName = databaseName || null;
  const resolvedCollectionName = collectionName || collection.collectionName || null;
  const operations = [];

  logReport({
    logger,
    mode,
    databaseName: resolvedDatabaseName,
    collectionName: resolvedCollectionName,
    report: initialReport,
  });

  if (!apply) {
    logger.log('DRY-RUN: no indexes were created. Re-run with --apply to create missing indexes.');
    return {
      mode,
      databaseName: resolvedDatabaseName,
      collectionName: resolvedCollectionName,
      initialReport,
      finalReport: initialReport,
      operations,
    };
  }

  if (typeof collection.createIndex !== 'function') {
    throw new Error('A Mongo collection with createIndex() is required when --apply is used');
  }

  for (const definition of REQUIRED_PUBLIC_NEWS_INDEXES) {
    const currentIndexes = await collection.indexes();
    const status = getIndexStatus(definition, currentIndexes);

    if (status.matches) {
      logger.log(`SKIPPED ${definition.name}`);
      operations.push({ name: definition.name, status: 'SKIPPED' });
      continue;
    }

    if (status.conflict) {
      logger.error(`CONFLICT ${definition.name}`);
      const error = new Error(`Conflicting index exists: ${definition.name}`);
      error.code = 'PUBLIC_NEWS_INDEX_CONFLICT';
      error.status = status;
      error.operations = operations;
      throw error;
    }

    logger.log(`START ${definition.name}`);
    operations.push({ name: definition.name, status: 'START' });
    try {
      await collection.createIndex(definition.key, createIndexOptions(definition));
      logger.log(`CREATED ${definition.name}`);
      operations.push({ name: definition.name, status: 'CREATED' });
    } catch (error) {
      logger.error(`FAILED ${definition.name}`);
      error.indexName = definition.name;
      error.operations = operations;
      throw error;
    }
  }

  const finalIndexes = await collection.indexes();
  const finalReport = summarizeRequiredIndexes(finalIndexes);
  logReport({
    logger,
    mode: 'verify',
    databaseName: resolvedDatabaseName,
    collectionName: resolvedCollectionName,
    report: finalReport,
  });

  const failed = finalReport.required.filter((index) => !index.matches);
  if (failed.length) {
    const error = new Error('Required public-news index verification failed');
    error.code = 'PUBLIC_NEWS_INDEX_VERIFY_FAILED';
    error.failed = failed;
    error.finalReport = finalReport;
    error.operations = operations;
    throw error;
  }

  return {
    mode,
    databaseName: resolvedDatabaseName,
    collectionName: resolvedCollectionName,
    initialReport,
    finalReport,
    operations,
  };
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
  await runPublicNewsIndexCreation({
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
  REQUIRED_PUBLIC_NEWS_INDEXES,
  collationContainsExpected,
  createIndexOptions,
  getIndexStatus,
  indexKeyMatchesExpected,
  indexOptionsMatchExpected,
  runPublicNewsIndexCreation,
  significantIndexOptions,
  summarizeRequiredIndexes,
};