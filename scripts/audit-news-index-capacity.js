const fs = require('fs');
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

const MAX_MONGODB_INDEXES_PER_COLLECTION = 64;
const MAX_REFERENCE_LINES_PER_INDEX = 20;
const REPO_ROOT = path.join(__dirname, '..');

const SCAN_DIRS = Object.freeze(['controllers', 'routes', 'services', 'scripts', 'models', 'lib', 'src']);
const SCAN_FILES = Object.freeze(['server.js']);
const SCAN_EXTENSIONS = Object.freeze(new Set(['.js', '.ts']));
const SKIP_DIRS = Object.freeze(new Set(['node_modules', '.git', 'uploads', 'data', 'coverage', 'dist', 'build', 'out', '.tmp', 'tmp']));
const KEEP_BY_DEFAULT_NAMES = Object.freeze(new Set(['_id_']));
const EXAMPLE_INDEX_NAMES = Object.freeze(new Set([
  'status_1',
  'category_1',
  'createdAt_-1',
  'status_1_createdAt_-1',
  'translationKey_1',
  'translationKey_1_lang_1_status_1_publishedAt_-1',
  'translationGroupId_1',
  'translationGroupId_1_lang_1_status_1_publishedAt_-1',
  'slugs.en_1',
  'topic_1',
  'topic_1_status_1_publishedAt_-1',
  'location.state_1',
  'location.state_1_status_1_publishedAt_-1',
]));

const EXAMPLE_INDEX_KEYS = Object.freeze({
  status_1: Object.freeze({ status: 1 }),
  category_1: Object.freeze({ category: 1 }),
  'createdAt_-1': Object.freeze({ createdAt: -1 }),
  'status_1_createdAt_-1': Object.freeze({ status: 1, createdAt: -1 }),
  translationKey_1: Object.freeze({ translationKey: 1 }),
  'translationKey_1_lang_1_status_1_publishedAt_-1': Object.freeze({ translationKey: 1, lang: 1, status: 1, publishedAt: -1 }),
  translationGroupId_1: Object.freeze({ translationGroupId: 1 }),
  'translationGroupId_1_lang_1_status_1_publishedAt_-1': Object.freeze({ translationGroupId: 1, lang: 1, status: 1, publishedAt: -1 }),
  'slugs.en_1': Object.freeze({ 'slugs.en': 1 }),
  topic_1: Object.freeze({ topic: 1 }),
  'topic_1_status_1_publishedAt_-1': Object.freeze({ topic: 1, status: 1, publishedAt: -1 }),
  'location.state_1': Object.freeze({ 'location.state': 1 }),
  'location.state_1_status_1_publishedAt_-1': Object.freeze({ 'location.state': 1, status: 1, publishedAt: -1 }),
});

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

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function significantIndexOptions(indexLike = {}) {
  const out = {};
  for (const key of SIGNIFICANT_INDEX_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(indexLike, key)) out[key] = indexLike[key];
  }
  return out;
}

function keyEntries(key = {}) {
  return Object.entries(key || {});
}

function keyFieldNames(key = {}) {
  return keyEntries(key).map(([field]) => field);
}

function keySignature(key = {}) {
  return stableStringify(key || {});
}

function optionsSignature(options = {}) {
  return stableStringify(significantIndexOptions(options || {}));
}

function autoIndexName(key = {}) {
  return keyEntries(key).map(([field, order]) => `${field}_${order}`).join('_');
}

function declaredIndexName(key, options = {}) {
  return options && options.name ? options.name : autoIndexName(key);
}

function summarizeDeclaredIndexes(schemaIndexes) {
  return (schemaIndexes || []).map(([key, options]) => ({
    name: declaredIndexName(key, options),
    key,
    options: significantIndexOptions(options || {}),
  }));
}

function summarizeActualIndexes(actualIndexes) {
  return (actualIndexes || []).map((index) => ({
    name: index.name,
    key: index.key || {},
    options: significantIndexOptions(index),
  }));
}

function isPrefixKey(prefixKey = {}, longerKey = {}) {
  const prefix = keyEntries(prefixKey);
  const longer = keyEntries(longerKey);
  if (!prefix.length || prefix.length >= longer.length) return false;
  return prefix.every(([field, order], index) => {
    const [longerField, longerOrder] = longer[index] || [];
    return field === longerField && order === longerOrder;
  });
}

function isSubsetKey(subsetKey = {}, supersetKey = {}) {
  const subset = keyEntries(subsetKey);
  const superset = new Map(keyEntries(supersetKey));
  if (!subset.length || subset.length >= superset.size) return false;
  return subset.every(([field, order]) => superset.get(field) === order);
}

function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items || []) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.values()).filter((group) => group.length > 1);
}

function findExactDuplicateKeyPatterns(actualIndexes) {
  return groupBy(actualIndexes, (index) => `${keySignature(index.key)}|${optionsSignature(index.options)}`)
    .map((group) => ({
      category: 'exactDuplicateKeyPattern',
      indexes: group.map((index) => index.name),
      key: group[0].key,
      options: group[0].options,
      reason: 'Same key pattern and significant options appear under multiple index names.',
    }));
}

function findSingleFieldPrefixCandidates(actualIndexes) {
  const out = [];
  for (const index of actualIndexes || []) {
    if (KEEP_BY_DEFAULT_NAMES.has(index.name)) continue;
    if (keyEntries(index.key).length !== 1) continue;
    const coveredBy = (actualIndexes || [])
      .filter((other) => other.name !== index.name && isPrefixKey(index.key, other.key))
      .map((other) => other.name);
    if (!coveredBy.length) continue;
    out.push({
      category: 'singleFieldPrefixOfCompound',
      indexName: index.name,
      key: index.key,
      coveredBy,
      reason: 'Single-field index is a left-prefix of one or more compound indexes. This is only a review signal; standalone filters/sorts may still need it.',
    });
  }
  return out;
}

function findCompoundPrefixOrSubsetCandidates(actualIndexes) {
  const out = [];
  for (const index of actualIndexes || []) {
    if (KEEP_BY_DEFAULT_NAMES.has(index.name)) continue;
    if (keyEntries(index.key).length < 2) continue;
    const prefixOf = [];
    const subsetOf = [];
    for (const other of actualIndexes || []) {
      if (other.name === index.name) continue;
      if (isPrefixKey(index.key, other.key)) prefixOf.push(other.name);
      else if (isSubsetKey(index.key, other.key)) subsetOf.push(other.name);
    }
    if (!prefixOf.length && !subsetOf.length) continue;
    out.push({
      category: 'compoundPrefixOrSubsetOfCompound',
      indexName: index.name,
      key: index.key,
      prefixOf,
      subsetOf,
      reason: 'Compound index is a prefix or same-order-field subset of a larger compound index. Sort order and query shape must be reviewed before any drop.',
    });
  }
  return out;
}

function findActualNotDeclared(actualIndexes, declaredIndexes) {
  const declaredNames = new Set((declaredIndexes || []).map((index) => index.name));
  const declaredKeyAndOptions = new Set((declaredIndexes || []).map((index) => `${keySignature(index.key)}|${optionsSignature(index.options)}`));
  return (actualIndexes || [])
    .filter((index) => !KEEP_BY_DEFAULT_NAMES.has(index.name))
    .filter((index) => !declaredNames.has(index.name) && !declaredKeyAndOptions.has(`${keySignature(index.key)}|${optionsSignature(index.options)}`))
    .map((index) => ({
      category: 'actualIndexNotDeclaredInSchema',
      indexName: index.name,
      key: index.key,
      reason: 'Actual MongoDB index is not declared in News.schema.indexes() by name or equivalent key/options.',
    }));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencePatternsForIndex(index) {
  const fields = keyFieldNames(index.key);
  const patterns = new Set([index.name, ...fields]);
  for (const field of fields) {
    patterns.add(`'${field}'`);
    patterns.add(`"${field}"`);
    patterns.add(`${field}:`);
  }
  return Array.from(patterns).filter(Boolean);
}

function listScanFiles(root = REPO_ROOT) {
  const files = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      files.push(fullPath);
    }
  }

  for (const dir of SCAN_DIRS) walk(path.join(root, dir));
  for (const file of SCAN_FILES) {
    const fullPath = path.join(root, file);
    if (fs.existsSync(fullPath)) files.push(fullPath);
  }

  return Array.from(new Set(files));
}

function collectCodeReferencesForIndex(index, { root = REPO_ROOT, maxRefs = MAX_REFERENCE_LINES_PER_INDEX } = {}) {
  const patterns = referencePatternsForIndex(index);
  const regexes = patterns.map((pattern) => new RegExp(escapeRegExp(pattern), 'i'));
  const refs = [];

  for (const file of listScanFiles(root)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
      const line = lines[indexLine];
      if (!regexes.some((regex) => regex.test(line))) continue;
      refs.push({
        path: path.relative(root, file).replace(/\\/g, '/'),
        line: indexLine + 1,
        text: line.trim().slice(0, 240),
      });
      if (refs.length >= maxRefs) return refs;
    }
  }

  return refs;
}

function confidenceForCandidate(candidate, refs, usageCount) {
  if (candidate.category === 'exactDuplicateKeyPattern') return refs.length ? 'medium' : 'high';
  if (candidate.category === 'actualIndexNotDeclaredInSchema' && refs.length === 0 && usageCount === 0) return 'high';
  if (candidate.category === 'schemaDeclaredButNoStaticNewsReferences' && refs.length === 0 && usageCount === 0) return 'medium';
  if (candidate.category === 'singleFieldPrefixOfCompound' && refs.length === 0 && usageCount === 0) return 'medium';
  return 'low';
}

function buildDeclaredButApparentlyUnusedCandidates(declaredIndexes, referencesByName) {
  return (declaredIndexes || [])
    .filter((index) => !KEEP_BY_DEFAULT_NAMES.has(index.name))
    .filter((index) => !(referencesByName.get(index.name) || []).length)
    .map((index) => ({
      category: 'schemaDeclaredButNoStaticNewsReferences',
      indexName: index.name,
      key: index.key,
      reason: 'Index is declared on the News schema, but this static scan did not find direct field/name references in current backend query code.',
    }));
}

function buildCandidateReport({ actualIndexes, declaredIndexes, usageByName = new Map(), root = REPO_ROOT }) {
  const referencesByName = new Map();
  for (const index of actualIndexes || []) {
    referencesByName.set(index.name, collectCodeReferencesForIndex(index, { root }));
  }
  for (const index of declaredIndexes || []) {
    if (!referencesByName.has(index.name)) {
      referencesByName.set(index.name, collectCodeReferencesForIndex(index, { root }));
    }
  }

  const rawCandidates = [
    ...findExactDuplicateKeyPatterns(actualIndexes).flatMap((group) => group.indexes.map((name) => ({
      category: group.category,
      indexName: name,
      key: group.key,
      duplicateGroup: group.indexes,
      reason: group.reason,
    }))),
    ...findSingleFieldPrefixCandidates(actualIndexes),
    ...findCompoundPrefixOrSubsetCandidates(actualIndexes),
    ...findActualNotDeclared(actualIndexes, declaredIndexes),
    ...buildDeclaredButApparentlyUnusedCandidates(declaredIndexes, referencesByName),
  ];

  const byNameAndCategory = new Map();
  for (const candidate of rawCandidates) {
    const key = `${candidate.indexName}|${candidate.category}`;
    if (!byNameAndCategory.has(key)) byNameAndCategory.set(key, candidate);
  }

  const candidates = Array.from(byNameAndCategory.values()).map((candidate) => {
    const refs = referencesByName.get(candidate.indexName) || [];
    const usageCount = Number(usageByName.get(candidate.indexName)?.accesses?.ops || 0);
    return {
      ...candidate,
      queryReferences: refs,
      indexUsageOps: usageCount,
      usageNote: 'Observational only: zero usage does not automatically mean an index is safe to drop.',
      confidence: confidenceForCandidate(candidate, refs, usageCount),
    };
  });

  return {
    highConfidencePossibleDropCandidates: candidates.filter((candidate) => candidate.confidence === 'high'),
    mediumConfidenceCandidatesRequiringReview: candidates.filter((candidate) => candidate.confidence === 'medium'),
    lowConfidenceSignals: candidates.filter((candidate) => candidate.confidence === 'low'),
  };
}

function mustKeepIndexes(actualIndexes, candidateReport) {
  const candidateNames = new Set([
    ...candidateReport.highConfidencePossibleDropCandidates,
    ...candidateReport.mediumConfidenceCandidatesRequiringReview,
    ...candidateReport.lowConfidenceSignals,
  ].map((candidate) => candidate.indexName));

  return (actualIndexes || [])
    .filter((index) => KEEP_BY_DEFAULT_NAMES.has(index.name) || !candidateNames.has(index.name))
    .map((index) => ({ name: index.name, key: index.key }));
}

function buildSpecificExampleIndexOverlap({ actualIndexes, declaredIndexes, usageByName = new Map(), root = REPO_ROOT }) {
  const actualByName = new Map((actualIndexes || []).map((index) => [index.name, index]));
  const declaredByName = new Map((declaredIndexes || []).map((index) => [index.name, index]));

  return Array.from(EXAMPLE_INDEX_NAMES).map((name) => {
    const actual = actualByName.get(name) || null;
    const declared = declaredByName.get(name) || null;
    const key = actual?.key || declared?.key || EXAMPLE_INDEX_KEYS[name] || {};
    const indexLike = { name, key };
    const prefixOf = (actualIndexes || [])
      .filter((other) => other.name !== name && isPrefixKey(key, other.key))
      .map((other) => other.name);
    const subsetOf = (actualIndexes || [])
      .filter((other) => other.name !== name && !isPrefixKey(key, other.key) && isSubsetKey(key, other.key))
      .map((other) => other.name);

    return {
      name,
      key,
      actualExists: Boolean(actual),
      declaredInNewsSchema: Boolean(declared),
      usage: usageByName.get(name)?.accesses || null,
      prefixOf,
      subsetOf,
      queryReferences: collectCodeReferencesForIndex(indexLike, { root }),
      reviewNote: 'Named example inspected for overlap only. This is not a drop recommendation.',
    };
  });
}

async function collectIndexStats(collection) {
  try {
    const stats = await collection.aggregate([{ $indexStats: {} }]).toArray();
    return {
      supported: true,
      note: 'Observational only: index usage resets on mongod restart, primary step-up, or collection/index recreation. Zero usage does not automatically mean safe to drop.',
      stats: (stats || []).map((item) => ({
        name: item.name,
        key: item.key,
        accesses: item.accesses || null,
      })),
    };
  } catch (error) {
    return {
      supported: false,
      error: error?.message || String(error),
      note: '$indexStats was unavailable; candidate confidence falls back to schema/code-shape signals only.',
      stats: [],
    };
  }
}

async function collectServerStatus(connection) {
  try {
    const status = await connection.db.admin().serverStatus();
    return {
      supported: true,
      uptimeSeconds: status.uptime,
      localTime: status.localTime,
      note: 'Uptime provides context for $indexStats. Short uptime makes low/zero usage less informative.',
    };
  } catch (error) {
    return {
      supported: false,
      error: error?.message || String(error),
      note: 'Server uptime unavailable; treat $indexStats usage as observational only.',
    };
  }
}

function buildAuditReport({ databaseName, collectionName, actualRawIndexes, schemaIndexes, indexStats, serverStatus, root = REPO_ROOT }) {
  const actualIndexes = summarizeActualIndexes(actualRawIndexes);
  const declaredIndexes = summarizeDeclaredIndexes(schemaIndexes);
  const usageByName = new Map((indexStats?.stats || []).map((item) => [item.name, item]));
  const candidateReport = buildCandidateReport({ actualIndexes, declaredIndexes, usageByName, root });
  const totalActualIndexCount = actualIndexes.length;
  const indexCapacityRemaining = Math.max(MAX_MONGODB_INDEXES_PER_COLLECTION - totalActualIndexCount, 0);

  return {
    mode: 'read-only',
    databaseName,
    collectionName,
    maxMongoIndexesPerCollection: MAX_MONGODB_INDEXES_PER_COLLECTION,
    totalActualIndexCount,
    indexCapacityRemaining,
    actualIndexes,
    declaredIndexes,
    potentialRedundancyCategories: {
      exactDuplicateKeyPatterns: findExactDuplicateKeyPatterns(actualIndexes),
      singleFieldIndexesThatArePrefixesOfCompoundIndexes: findSingleFieldPrefixCandidates(actualIndexes),
      compoundIndexesThatArePrefixesOrSubsetsOfAnotherCompoundIndex: findCompoundPrefixOrSubsetCandidates(actualIndexes),
      schemaDeclaredButApparentlyNotReferenced: buildDeclaredButApparentlyUnusedCandidates(declaredIndexes, new Map(declaredIndexes.map((index) => [index.name, collectCodeReferencesForIndex(index, { root })]))),
      actualIndexesNoLongerDeclaredInNewsSchema: findActualNotDeclared(actualIndexes, declaredIndexes),
    },
    specificExampleIndexOverlap: buildSpecificExampleIndexOverlap({ actualIndexes, declaredIndexes, usageByName, root }),
    indexUsage: indexStats,
    serverStatus,
    highConfidencePossibleDropCandidates: candidateReport.highConfidencePossibleDropCandidates,
    mediumConfidenceCandidatesRequiringReview: candidateReport.mediumConfidenceCandidatesRequiringReview,
    lowConfidenceSignals: candidateReport.lowConfidenceSignals,
    indexesThatMustDefinitelyBeKept: mustKeepIndexes(actualIndexes, candidateReport),
    highConfidenceSlotsThatCouldBeFreedIfLaterApproved: candidateReport.highConfidencePossibleDropCandidates.length,
    caution: 'This report is conservative and read-only. It does not decide drops automatically; review query plans, production traffic, index options, and rollout risk before any future dropIndex operation.',
  };
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DBNAME || '').trim() || undefined;

  if (!uri) throw new Error('Missing MONGODB_URI or legacy MONGO_URI');

  await mongoose.connect(uri, {
    ...(dbName ? { dbName } : {}),
    autoIndex: false,
    autoCreate: false,
  });

  const collection = News.collection;
  const [actualRawIndexes, indexStats, serverStatus] = await Promise.all([
    collection.indexes(),
    collectIndexStats(collection),
    collectServerStatus(mongoose.connection),
  ]);

  const report = buildAuditReport({
    databaseName: mongoose.connection.name,
    collectionName: collection.collectionName,
    actualRawIndexes,
    schemaIndexes: News.schema.indexes(),
    indexStats,
    serverStatus,
  });

  console.log(JSON.stringify(report, null, 2));
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
  buildAuditReport,
  buildCandidateReport,
  buildSpecificExampleIndexOverlap,
  findActualNotDeclared,
  findCompoundPrefixOrSubsetCandidates,
  findExactDuplicateKeyPatterns,
  findSingleFieldPrefixCandidates,
  isPrefixKey,
  isSubsetKey,
  significantIndexOptions,
  summarizeActualIndexes,
  summarizeDeclaredIndexes,
};