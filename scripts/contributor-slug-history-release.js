const { normalizeContributorSlug, normalizeContributorSlugHistory } = require('../lib/contributorSlugHistory');
const { HISTORY_INDEX, contributorIndexReadiness } = require('../lib/contributorSlugReadiness');

const MAX_RECORDS = 100000;
const ACTIONS = ['audit', 'backfill', 'create-index', 'verify'];

function refuse(code) {
  throw Object.assign(new Error(code), { releaseCode: code });
}

function parseArgs(args) {
  const options = { action: 'audit', apply: false, writersPaused: false, newVersionOnly: false };
  for (const arg of args) {
    if (arg.startsWith('--action=')) options.action = arg.slice('--action='.length);
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--writers-paused') options.writersPaused = true;
    else if (arg === '--new-version-only') options.newVersionOnly = true;
    else refuse('UNKNOWN_ARGUMENT');
  }
  if (!ACTIONS.includes(options.action) || (options.apply && options.dryRun)
    || (options.apply && ['audit', 'verify'].includes(options.action))) refuse('INVALID_ACTION');
  return options;
}

function addOwner(map, value, owner) {
  if (!map.has(value)) map.set(value, new Set());
  map.get(value).add(owner);
}

function analyzeContributors(records, indexes, collectionOptions = {}) {
  const currentOwners = new Map();
  const historyOwners = new Map();
  const normalizedCurrentOwners = new Map();
  const findings = {
    duplicateCurrentSlugs: [], duplicateHistoricalSlugs: [], currentHistoryConflicts: [],
    invalidCurrentSlugs: [], malformedHistories: [], missingHistory: [], currentMissingFromHistory: [],
    duplicateHistoryValues: [], normalizedCurrentCollisions: [],
  };
  const candidates = [];
  for (const record of records) {
    const owner = String(record._id);
    const canonical = normalizeContributorSlug(record.slug);
    if (typeof record.slug === 'string') addOwner(currentOwners, record.slug, owner);
    if (canonical) addOwner(normalizedCurrentOwners, canonical, owner);
    if (!canonical || canonical !== record.slug) findings.invalidCurrentSlugs.push(owner);
    const missing = !Object.prototype.hasOwnProperty.call(record, 'slugHistory');
    const history = Array.isArray(record.slugHistory) ? record.slugHistory : [];
    if (missing) findings.missingHistory.push(owner);
    const malformed = !missing && (!Array.isArray(record.slugHistory)
      || history.some(value => typeof value !== 'string' || !normalizeContributorSlug(value) || normalizeContributorSlug(value) !== value));
    if (malformed) findings.malformedHistories.push(owner);
    const normalizedHistory = normalizeContributorSlugHistory(history);
    const duplicate = Array.isArray(record.slugHistory) && history.length !== new Set(history).size;
    if (duplicate) findings.duplicateHistoryValues.push(owner);
    for (const value of normalizedHistory) addOwner(historyOwners, value, owner);
    if (!history.includes(record.slug) || missing) {
      findings.currentMissingFromHistory.push(owner);
      if (canonical && canonical === record.slug && !malformed && !duplicate) candidates.push(record);
    }
  }
  const duplicatedOwners = map => [...map.values()].filter(owners => owners.size > 1).map(owners => [...owners]);
  findings.duplicateCurrentSlugs = duplicatedOwners(currentOwners);
  findings.duplicateHistoricalSlugs = duplicatedOwners(historyOwners);
  findings.normalizedCurrentCollisions = duplicatedOwners(normalizedCurrentOwners);
  for (const [slug, owners] of normalizedCurrentOwners) {
    for (const owner of owners) {
      const conflicts = [...(historyOwners.get(slug) || [])].filter(other => other !== owner);
      if (conflicts.length) findings.currentHistoryConflicts.push({ owner, conflicts });
    }
  }
  const indexReadiness = contributorIndexReadiness(indexes);
  const historyIndexConflict = !indexReadiness.slugHistory && indexes.some(index => index.name === 'slugHistory_1' || Object.hasOwn(index.key || {}, 'slugHistory'));
  const blockers = Object.entries(findings)
    .filter(([name, values]) => !['missingHistory', 'currentMissingFromHistory'].includes(name) && values.length)
    .map(([name]) => name);
  if (!indexReadiness.slug) blockers.push('canonicalUniqueIndexNotVerified');
  if (historyIndexConflict) blockers.push('historyIndexOptionsConflict');
  if (collectionOptions.collation && collectionOptions.collation.locale !== 'simple') blockers.push('unsupportedCollectionCollation');
  if (collectionOptions.validator) blockers.push('collectionValidatorRequiresReview');
  if (collectionOptions.capped || collectionOptions.timeseries || collectionOptions.clusteredIndex) blockers.push('unsupportedCollectionOptions');
  return {
    candidates,
    report: {
      totalContributors: records.length,
      counts: Object.fromEntries(Object.entries(findings).map(([name, values]) => [name, values.length])),
      examples: Object.fromEntries(Object.entries(findings).map(([name, values]) => [name, values.slice(0, 20)])),
      indexes, indexReadiness, blockers, safeReservationCandidates: candidates.length,
      ready: blockers.length === 0 && findings.currentMissingFromHistory.length === 0 && indexReadiness.ready,
    },
  };
}

async function auditContributors(collection) {
  const indexes = await collection.listIndexes({ maxTimeMS: 10000 }).toArray();
  const collectionOptions = await collection.options({ maxTimeMS: 10000 });
  const records = await collection.find({}, { projection: { _id: 1, slug: 1, slugHistory: 1 } })
    .limit(MAX_RECORDS + 1).maxTimeMS(10000).toArray();
  if (records.length > MAX_RECORDS) refuse('AUDIT_LIMIT_EXCEEDED');
  return analyzeContributors(records, indexes, collectionOptions);
}

async function runRelease(collection, options = {}, env = process.env) {
  const { action = 'audit', apply = false, writersPaused = false, newVersionOnly = false } = options;
  if (!ACTIONS.includes(action) || (apply && (options.dryRun || ['audit', 'verify'].includes(action)))) refuse('INVALID_ACTION');
  if (apply && (!writersPaused || !newVersionOnly
    || String(env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED || '').trim().toLowerCase() === 'true')) refuse('WRITE_SAFETY_ACKNOWLEDGEMENTS_REQUIRED');
  const audit = await auditContributors(collection);
  if (!apply) return { action, mode: 'dry-run', ...audit.report };
  if (audit.report.blockers.length) refuse('PREFLIGHT_CONFLICTS');
  let initialized = 0;
  if (action === 'backfill') {
    for (const record of audit.candidates) {
      const slugHistory = normalizeContributorSlugHistory(record.slugHistory, record.slug);
      const conflict = await collection.findOne({ _id: { $ne: record._id }, $or: [
        { slug: { $in: slugHistory } }, { slugHistory: { $in: slugHistory } },
      ] }, { projection: { _id: 1 }, maxTimeMS: 10000 });
      if (conflict) refuse('RESERVATION_CONFLICT');
      const filter = { _id: record._id, slug: record.slug,
        slugHistory: Object.hasOwn(record, 'slugHistory') ? record.slugHistory : { $exists: false } };
      const result = await collection.updateOne(filter, { $set: { slugHistory } }, { writeConcern: { w: 'majority' } });
      if (result.matchedCount !== 1) refuse('CONCURRENT_CONTRIBUTOR_CHANGE');
      initialized += 1;
    }
  } else if (action === 'create-index') {
    if (audit.report.counts.currentMissingFromHistory) refuse('RESERVATIONS_INCOMPLETE');
    if (!audit.report.indexReadiness.slugHistory) await collection.createIndex(HISTORY_INDEX.key, HISTORY_INDEX.options);
  }
  const after = await auditContributors(collection);
  if (after.report.blockers.length || after.report.counts.currentMissingFromHistory
    || (action === 'create-index' && !after.report.ready)) refuse('POSTCHECK_FAILED');
  return { action, mode: 'apply', initialized, ...after.report };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const uri = process.env.PULSE_DIALOGUE_RELEASE_MONGODB_URI;
  const database = process.env.PULSE_DIALOGUE_RELEASE_DBNAME;
  if (!uri || !database) refuse('EXPLICIT_RELEASE_CONNECTION_REQUIRED');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(uri, { maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const result = await runRelease(client.db(database).collection('contributors'), options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.releaseCode || 'CONTRIBUTOR_RELEASE_FAILED' }));
  process.exitCode = 1;
});

module.exports = { parseArgs, analyzeContributors, auditContributors, runRelease };