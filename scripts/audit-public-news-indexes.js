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
const { getPublicCategoryMatchValues, getCanonicalPublicCategoryKey } = require('../lib/categories');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');
const { normalizeLang } = require('../services/mapArticleForLang');
const {
  getPublicContentLookup,
  buildPublicContentSiblingOrClauses,
} = require('../services/publicCategoryListing.service');

const REQUIRED_PUBLIC_NEWS_INDEXES = Object.freeze([
  'public_news_latest_status_published_created',
  'public_news_category_status_published_created_ci',
  'public_news_sibling_translation_key_status_published_created',
  'public_news_sibling_translation_group_status_published_created',
  'public_news_sibling_slug_status_published_created',
  'public_news_sibling_slugs_en_status_published_created',
]);

const EXPECTED_CATEGORY_COLLATION = Object.freeze({ locale: 'en', strength: 2 });
const PUBLIC_NEWS_CATEGORY_COLLATION = Object.freeze({ locale: 'en', strength: 2 });
const SIBLING_PREPARE_PROJECTION = Object.freeze({
  _id: 0,
  translationKey: 1,
  translationGroupId: 1,
  slug: 1,
  'slugs.en': 1,
});
const SIBLING_PREPARE_FIELD_GROUPS = Object.freeze([
  Object.freeze({ label: 'category.siblings.prepare.translationKeys', projection: Object.freeze({ _id: 0, translationKey: 1, translationGroupId: 1 }) }),
  Object.freeze({ label: 'category.siblings.prepare.slug', projection: Object.freeze({ _id: 0, slug: 1 }) }),
  Object.freeze({ label: 'category.siblings.prepare.slugsEn', projection: Object.freeze({ _id: 0, 'slugs.en': 1 }) }),
]);

function parseArgs(argv) {
  const args = {
    explain: false,
    lang: 'gu',
    category: 'business',
    limit: 30,
    page: 1,
  };

  for (const arg of argv) {
    if (arg === '--explain') {
      args.explain = true;
      continue;
    }

    const match = String(arg || '').match(/^--([^=]+)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2];
    if (key === 'lang') args.lang = value || args.lang;
    if (key === 'category') args.category = value || args.category;
    if (key === 'limit') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) args.limit = Math.min(parsed, 100);
    }
    if (key === 'page') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) args.page = parsed;
    }
  }

  return args;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeIndexOptions(options = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (key === 'key' || key === 'name' || key === 'ns' || key === 'v') continue;
    normalized[key] = value;
  }
  return normalized;
}

function safeDiagnosticError(error) {
  const rawMessage = String(error && error.message ? error.message : error || 'diagnostic failed');
  const safeMessage = /invalid utf-?8 string in bson document/i.test(rawMessage)
    ? 'Invalid UTF-8 string in BSON document'
    : rawMessage.replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  return {
    errorName: String(error && error.name ? error.name : 'Error').slice(0, 80),
    errorMessage: safeMessage,
  };
}

async function runDiagnosticSection(label, fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      label,
      ok: false,
      ...safeDiagnosticError(error),
    };
  }
}

function collationContainsExpected(actualCollation, expectedCollation) {
  if (!expectedCollation) return !actualCollation;
  if (!actualCollation || typeof actualCollation !== 'object') return false;

  return Object.entries(expectedCollation).every(([key, expectedValue]) => (
    stableStringify(actualCollation[key]) === stableStringify(expectedValue)
  ));
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

function declaredIndexName(fields, options = {}) {
  if (options && options.name) return options.name;
  return Object.entries(fields || {}).map(([key, value]) => `${key}_${value}`).join('_');
}

function summarizeDeclaredIndexes() {
  return News.schema.indexes().map(([key, options]) => ({
    name: declaredIndexName(key, options),
    key,
    options: normalizeIndexOptions(options),
  }));
}

function summarizeActualIndexes(indexes) {
  return indexes.map((index) => ({
    name: index.name,
    key: index.key,
    options: normalizeIndexOptions(index),
  }));
}

function compareDeclaredToActual(declaredIndexes, actualIndexes) {
  const actualByName = new Map(actualIndexes.map((index) => [index.name, index]));

  return declaredIndexes.map((declared) => {
    const actual = actualByName.get(declared.name) || null;
    const keyMatches = actual ? indexKeyMatchesExpected(actual.key, declared.key) : false;
    const collationMatches = declared.options && declared.options.collation
      ? collationContainsExpected(actual && actual.options ? actual.options.collation : null, declared.options.collation)
      : undefined;
    const matches = Boolean(actual && keyMatches && (collationMatches === undefined || collationMatches));

    return {
      name: declared.name,
      declaredKey: declared.key,
      actualKey: actual ? actual.key : null,
      exists: Boolean(actual),
      keyMatches,
      matches,
      ...(collationMatches !== undefined ? {
        declaredCollation: declared.options.collation,
        actualCollation: actual && actual.options ? actual.options.collation || null : null,
        collationMatches,
      } : {}),
    };
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLanguage(value) {
  const lang = normalizeLang(value);
  return lang || null;
}

function buildOriginalLangMatch(lang) {
  const lower = String(lang).trim().toLowerCase();
  const upper = lower.toUpperCase();
  return {
    $or: [
      { originalLang: { $in: [lower, upper] } },
      {
        $and: [
          { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
          { $or: [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }] },
        ],
      },
    ],
  };
}

function buildReadyTranslationMatch(lang) {
  const desired = String(lang).trim().toLowerCase();
  return {
    $and: [
      { [`translationStatus.${desired}`]: 'ready' },
      { [`translations.${desired}.title`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.summary`]: { $exists: true, $ne: '' } },
      { [`translations.${desired}.content`]: { $exists: true, $ne: '' } },
    ],
  };
}

function buildPublicNewsCategoryFilter(value) {
  const matchValues = getPublicCategoryMatchValues(value);
  return matchValues.length ? { $in: matchValues } : null;
}

function buildPublicPublishedFilter({ category } = {}) {
  const normalizedCategory = category ? getCanonicalPublicCategoryKey(category) : null;
  const filter = buildPubliclyVisibleNewsArticleFilter();

  if (normalizedCategory) {
    filter.category = buildPublicNewsCategoryFilter(normalizedCategory);
  }

  return filter;
}

function buildLatestFilter({ lang }) {
  const desired = normalizeLanguage(lang) || 'gu';
  const filter = buildPublicPublishedFilter({});
  filter.$and.push({
    $or: [
      buildOriginalLangMatch(desired),
      buildReadyTranslationMatch(desired),
    ],
  });
  return filter;
}

function buildCategoryFilter({ category }) {
  const normalizedCategory = getCanonicalPublicCategoryKey(category) || 'business';
  return buildPublicPublishedFilter({ category: normalizedCategory });
}

function collectPlanStages(node, stages = [], seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return stages;
  if (seen.has(node)) return stages;
  seen.add(node);

  if (node.stage) stages.push(node.stage);
  if (node.inputStage) collectPlanStages(node.inputStage, stages, seen);
  if (node.inputStages) {
    for (const child of node.inputStages) collectPlanStages(child, stages, seen);
  }
  if (node.shards) {
    for (const shard of node.shards) collectPlanStages(shard.winningPlan || shard.executionStages || shard, stages, seen);
  }
  if (node.queryPlan) collectPlanStages(node.queryPlan, stages, seen);
  if (node.winningPlan) collectPlanStages(node.winningPlan, stages, seen);

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const child of value) collectPlanStages(child, stages, seen);
      } else {
        collectPlanStages(value, stages, seen);
      }
    }
  }

  return stages;
}

function findExecutionStats(node, seen = new WeakSet()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (node.executionStats && typeof node.executionStats === 'object') return node.executionStats;
  if (
    Object.prototype.hasOwnProperty.call(node, 'nReturned')
    || Object.prototype.hasOwnProperty.call(node, 'executionTimeMillis')
    || Object.prototype.hasOwnProperty.call(node, 'totalKeysExamined')
    || Object.prototype.hasOwnProperty.call(node, 'totalDocsExamined')
  ) {
    return node;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const child of value) {
          const found = findExecutionStats(child, seen);
          if (found) return found;
        }
      } else {
        const found = findExecutionStats(value, seen);
        if (found) return found;
      }
    }
  }

  return null;
}

function collectIndexNames(node, names = []) {
  if (!node || typeof node !== 'object') return names;

  if (node.indexName) names.push(node.indexName);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const child of value) collectIndexNames(child, names);
      } else {
        collectIndexNames(value, names);
      }
    }
  }

  return names;
}

function summarizeExplain(explain) {
  const queryPlanner = explain && explain.queryPlanner ? explain.queryPlanner : {};
  const executionStats = findExecutionStats(explain) || {};
  const winningPlan = queryPlanner.winningPlan || null;
  const stages = Array.from(new Set(collectPlanStages(winningPlan || explain)));
  const winningIndexNames = Array.from(new Set(collectIndexNames(explain)));

  return {
    winningIndexNames,
    stages,
    hasCollscan: stages.includes('COLLSCAN'),
    hasSortStage: stages.includes('SORT'),
    nReturned: executionStats.nReturned,
    executionTimeMillis: executionStats.executionTimeMillis,
    totalKeysExamined: executionStats.totalKeysExamined,
    totalDocsExamined: executionStats.totalDocsExamined,
  };
}

async function explainFind({ collection, label, filter, sort, skip, limit, collation }) {
  let cursor = collection.find(filter, { projection: { _id: 1 } });
  if (sort) cursor = cursor.sort(sort);
  if (skip) cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  if (collation) cursor = cursor.collation(collation);
  const explain = await cursor.explain('executionStats');
  return {
    label,
    operation: 'find',
    filterShape: filter,
    ...(sort ? { sort } : {}),
    ...(skip ? { skip } : {}),
    ...(limit ? { limit } : {}),
    ...(collation ? { collation } : {}),
    summary: summarizeExplain(explain),
  };
}

async function explainCountDocuments({ collection, label, filter, collation, productionOperation = true }) {
  const pipeline = [{ $match: filter }, { $count: 'count' }];
  const cursor = collection.aggregate(pipeline, {
    ...(collation ? { collation } : {}),
  });
  const explain = await cursor.explain('executionStats');
  return {
    label,
    operation: 'countDocuments',
    productionOperation,
    filterShape: filter,
    ...(collation ? { collation } : {}),
    summary: summarizeExplain(explain),
  };
}

async function collectCategorySiblingClauses({ collection, categoryFilter, collation }) {
  let cursor = collection.find(categoryFilter, { projection: SIBLING_PREPARE_PROJECTION });
  if (collation) cursor = cursor.collation(collation);
  const matchedDocs = await cursor.toArray();
  const lookups = (matchedDocs || []).map((doc) => getPublicContentLookup(doc));
  const groupKeys = Array.from(new Set(lookups.map((entry) => entry.groupKey).filter(Boolean)));
  const canonicalSlugs = Array.from(new Set(
    lookups
      .filter((entry) => !entry.groupKey && entry.canonicalSlug)
      .map((entry) => entry.canonicalSlug)
  ));

  return {
    matchedLookupCount: Array.isArray(matchedDocs) ? matchedDocs.length : 0,
    groupKeyCount: groupKeys.length,
    canonicalSlugCount: canonicalSlugs.length,
    siblingClauses: buildPublicContentSiblingOrClauses({ groupKeys, canonicalSlugs }),
  };
}

async function runSiblingPrepareFieldGroupDiagnostics({ collection, categoryFilter, collation }) {
  const diagnostics = [];

  for (const group of SIBLING_PREPARE_FIELD_GROUPS) {
    diagnostics.push(await runDiagnosticSection(group.label, async () => {
      let cursor = collection.find(categoryFilter, { projection: group.projection });
      if (collation) cursor = cursor.collation(collation);
      const docs = await cursor.toArray();
      return {
        label: group.label,
        ok: true,
        operation: 'find',
        fieldGroup: group.label.replace('category.siblings.prepare.', ''),
        projectionFields: Object.keys(group.projection).filter((field) => field !== '_id'),
        matchedLookupCount: Array.isArray(docs) ? docs.length : 0,
      };
    }));
  }

  return diagnostics;
}

function buildCategorySiblingFilter({ baseFilter, siblingClauses }) {
  if (!Array.isArray(siblingClauses) || !siblingClauses.length) return null;
  return {
    ...baseFilter,
    $and: [
      ...((baseFilter && Array.isArray(baseFilter.$and)) ? baseFilter.$and : []),
      { $or: siblingClauses },
    ],
  };
}

async function buildExplainDiagnostics({ collection, args }) {
  const sort = { publishedAt: -1, createdAt: -1 };
  const desiredLang = normalizeLanguage(args.lang) || 'gu';
  const categoryKey = getCanonicalPublicCategoryKey(args.category) || args.category;
  const latestFilter = buildLatestFilter({ lang: args.lang });
  const categoryFilter = buildCategoryFilter({ category: args.category });
  const skip = (Math.max(Number(args.page || 1), 1) - 1) * args.limit;
  const explain = [];

  explain.push(await runDiagnosticSection(`latest.find:${desiredLang}`, () => explainFind({
    collection,
    label: `latest.find:${desiredLang}`,
    filter: latestFilter,
    sort,
    skip,
    limit: args.limit,
  })));

  explain.push(await runDiagnosticSection(`latest.count:${desiredLang}`, () => explainCountDocuments({
    collection,
    label: `latest.count:${desiredLang}`,
    filter: latestFilter,
  })));

  explain.push(await runDiagnosticSection(`category.matched.find:${categoryKey}`, () => explainFind({
    collection,
    label: `category.matched.find:${categoryKey}`,
    filter: categoryFilter,
    sort,
    collation: PUBLIC_NEWS_CATEGORY_COLLATION,
  })));

  explain.push(await runDiagnosticSection(`category.matched.count:${categoryKey}`, () => explainCountDocuments({
    collection,
    label: `category.matched.count:${categoryKey}`,
    filter: categoryFilter,
    collation: PUBLIC_NEWS_CATEGORY_COLLATION,
    productionOperation: false,
  })));

  const siblingPrepare = await runDiagnosticSection('category.siblings.prepare', async () => {
    const inputs = await collectCategorySiblingClauses({
      collection,
      categoryFilter,
      collation: PUBLIC_NEWS_CATEGORY_COLLATION,
    });
    return {
      label: 'category.siblings.prepare',
      ok: true,
      operation: 'find',
      category: categoryKey,
      projectionFields: Object.keys(SIBLING_PREPARE_PROJECTION).filter((field) => field !== '_id'),
      siblingLookupMetadata: {
        matchedLookupCount: inputs.matchedLookupCount,
        groupKeyCount: inputs.groupKeyCount,
        canonicalSlugCount: inputs.canonicalSlugCount,
        siblingClauseCount: inputs.siblingClauses.length,
      },
      siblingInputs: inputs,
    };
  });
  const siblingInputs = siblingPrepare.siblingInputs || null;
  if (siblingPrepare.siblingInputs) delete siblingPrepare.siblingInputs;
  explain.push(siblingPrepare);

  if (!siblingPrepare.ok) {
    explain.push(...await runSiblingPrepareFieldGroupDiagnostics({
      collection,
      categoryFilter,
      collation: PUBLIC_NEWS_CATEGORY_COLLATION,
    }));
    explain.push({
      label: `category.siblings.find:${categoryKey}`,
      operation: 'find',
      skipped: true,
      reason: 'sibling preparation failed',
    });
    return explain;
  }

  const siblingFilter = buildCategorySiblingFilter({
    baseFilter: buildPublicPublishedFilter({}),
    siblingClauses: siblingInputs.siblingClauses,
  });

  if (siblingFilter) {
    const siblingExplain = await runDiagnosticSection(`category.siblings.find:${categoryKey}`, () => explainFind({
      collection,
      label: `category.siblings.find:${categoryKey}`,
      filter: siblingFilter,
      sort,
    }));
    if (siblingExplain.ok === false) {
      explain.push(siblingExplain);
    } else {
      explain.push({
        ...siblingExplain,
        siblingLookupMetadata: {
          matchedLookupCount: siblingInputs.matchedLookupCount,
          groupKeyCount: siblingInputs.groupKeyCount,
          canonicalSlugCount: siblingInputs.canonicalSlugCount,
          siblingClauseCount: siblingInputs.siblingClauses.length,
        },
      });
    }
  } else {
    explain.push({
      label: `category.siblings.find:${categoryKey}`,
      operation: 'find',
      skipped: true,
      reason: 'no sibling clauses were produced from category matched documents',
      siblingLookupMetadata: {
        matchedLookupCount: siblingInputs.matchedLookupCount,
        groupKeyCount: siblingInputs.groupKeyCount,
        canonicalSlugCount: siblingInputs.canonicalSlugCount,
        siblingClauseCount: 0,
      },
    });
  }

  return explain;
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
  const actualRawIndexes = await collection.indexes();
  const declaredIndexes = summarizeDeclaredIndexes();
  const actualIndexes = summarizeActualIndexes(actualRawIndexes);
  const comparisons = compareDeclaredToActual(declaredIndexes, actualIndexes);
  const comparisonByName = new Map(comparisons.map((comparison) => [comparison.name, comparison]));
  const required = REQUIRED_PUBLIC_NEWS_INDEXES.map((name) => comparisonByName.get(name) || {
    name,
    exists: false,
    keyMatches: false,
  });

  const categoryIndex = comparisonByName.get('public_news_category_status_published_created_ci') || null;

  const output = {
    databaseName: mongoose.connection.name,
    collectionName: collection.collectionName,
    diagnosticMode: {
      readOnly: true,
      mongooseAutoIndex: mongoose.get('autoIndex'),
      mongooseAutoCreate: mongoose.get('autoCreate'),
    },
    declaredIndexes,
    actualIndexes,
    requiredPublicNewsIndexes: required,
    missingRequiredPublicNewsIndexes: required.filter((index) => !index.exists).map((index) => index.name),
    categoryCollation: {
      expected: EXPECTED_CATEGORY_COLLATION,
      actual: categoryIndex && categoryIndex.actualCollation ? categoryIndex.actualCollation : null,
      matches: Boolean(categoryIndex && categoryIndex.collationMatches),
    },
  };

  if (args.explain) {
    output.explain = await buildExplainDiagnostics({ collection, args });
  }

  console.log(JSON.stringify(output, null, 2));
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
  EXPECTED_CATEGORY_COLLATION,
  SIBLING_PREPARE_PROJECTION,
  collationContainsExpected,
  buildCategorySiblingFilter,
  buildExplainDiagnostics,
  compareDeclaredToActual,
  indexKeyMatchesExpected,
  normalizeIndexOptions,
  runDiagnosticSection,
  safeDiagnosticError,
  summarizeExplain,
};