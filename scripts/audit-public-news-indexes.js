require('dotenv').config();

const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const News = require('../models/News');
const { getPublicCategoryMatchValues, getCanonicalPublicCategoryKey } = require('../lib/categories');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');
const { normalizeLang } = require('../services/mapArticleForLang');

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

function parseArgs(argv) {
  const args = {
    explain: false,
    lang: 'gu',
    category: 'business',
    limit: 30,
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
    const keyMatches = actual ? stableStringify(actual.key) === stableStringify(declared.key) : false;
    const collationMatches = declared.options && declared.options.collation
      ? stableStringify(actual && actual.options ? actual.options.collation : undefined) === stableStringify(declared.options.collation)
      : undefined;

    return {
      name: declared.name,
      declaredKey: declared.key,
      actualKey: actual ? actual.key : null,
      exists: Boolean(actual),
      keyMatches,
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

function collectPlanStages(node, stages = []) {
  if (!node || typeof node !== 'object') return stages;

  if (node.stage) stages.push(node.stage);
  if (node.inputStage) collectPlanStages(node.inputStage, stages);
  if (node.inputStages) {
    for (const child of node.inputStages) collectPlanStages(child, stages);
  }
  if (node.shards) {
    for (const shard of node.shards) collectPlanStages(shard.winningPlan || shard.executionStages || shard, stages);
  }
  if (node.queryPlan) collectPlanStages(node.queryPlan, stages);
  if (node.winningPlan) collectPlanStages(node.winningPlan, stages);

  return stages;
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
  const executionStats = explain && explain.executionStats ? explain.executionStats : {};
  const winningPlan = queryPlanner.winningPlan || null;
  const stages = Array.from(new Set(collectPlanStages(winningPlan)));
  const winningIndexNames = Array.from(new Set(collectIndexNames(winningPlan)));

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

async function explainFind({ collection, label, filter, sort, limit, collation }) {
  let cursor = collection.find(filter, { projection: { _id: 1 } }).sort(sort).limit(limit);
  if (collation) cursor = cursor.collation(collation);
  const explain = await cursor.explain('executionStats');
  return {
    label,
    filterShape: filter,
    sort,
    limit,
    ...(collation ? { collation } : {}),
    summary: summarizeExplain(explain),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DBNAME || '').trim() || undefined;

  if (!uri) throw new Error('Missing MONGODB_URI');

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
    const sort = { publishedAt: -1, createdAt: -1 };
    output.explain = [
      await explainFind({
        collection,
        label: `latest:${normalizeLanguage(args.lang) || 'gu'}`,
        filter: buildLatestFilter({ lang: args.lang }),
        sort,
        limit: args.limit,
      }),
      await explainFind({
        collection,
        label: `category:${getCanonicalPublicCategoryKey(args.category) || args.category}`,
        filter: buildCategoryFilter({ category: args.category }),
        sort,
        limit: args.limit,
        collation: PUBLIC_NEWS_CATEGORY_COLLATION,
      }),
    ];
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await mongoose.disconnect();
  } catch (_) {}
});