const TARGET_TTL_INDEXES = Object.freeze([
  Object.freeze({
    modelName: 'NewsPulseIncident',
    collectionName: 'news_pulse_incidents',
    indexName: 'expiresAt_1',
    expectedKey: Object.freeze({ expiresAt: 1 }),
    expectedExpireAfterSeconds: 0,
  }),
  Object.freeze({
    modelName: 'NewsPulseAlert',
    collectionName: 'news_pulse_alerts',
    indexName: 'expiresAt_1',
    expectedKey: Object.freeze({ expiresAt: 1 }),
    expectedExpireAfterSeconds: 0,
  }),
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function keysEqual(actual, expected) {
  const actualKeys = Object.keys(actual || {});
  const expectedKeys = Object.keys(expected || {});
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => Number(actual[key]) === Number(expected[key]));
}

function isUnsupportedCollModError(error) {
  const codeName = String(error?.codeName || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const code = Number(error?.code);
  return code === 59
    || code === 115
    || code === 13
    || codeName === 'commandnotfound'
    || codeName === 'illegaloperation'
    || codeName === 'unauthorized'
    || /collmod.*not.*supported|no such command|command not found|not allowed to do action \[collmod\]|unauthorized/i.test(message);
}

async function listCollectionIndexes(collection) {
  if (!collection || typeof collection !== 'object') throw new Error('MongoDB collection handle is required');
  if (typeof collection.indexes === 'function') return collection.indexes();
  if (typeof collection.listIndexes === 'function') return collection.listIndexes().toArray();
  throw new Error('Collection handle does not support index listing');
}

function summarizeTargetIndex(target, indexes) {
  const indexList = Array.isArray(indexes) ? indexes : [];
  const namedIndex = indexList.find((index) => index && index.name === target.indexName) || null;
  const sameKeyIndexes = indexList.filter((index) => index && keysEqual(index.key, target.expectedKey));
  const unexpectedSameKeyIndexes = sameKeyIndexes.filter((index) => index.name !== target.indexName);
  const existing = namedIndex || sameKeyIndexes[0] || null;

  const existingExpireAfterSeconds = existing && Object.prototype.hasOwnProperty.call(existing, 'expireAfterSeconds')
    ? existing.expireAfterSeconds
    : null;
  const matches = !!existing
    && existing.name === target.indexName
    && keysEqual(existing.key, target.expectedKey)
    && Number(existing.expireAfterSeconds) === Number(target.expectedExpireAfterSeconds)
    && unexpectedSameKeyIndexes.length === 0;

  return {
    modelName: target.modelName,
    collectionName: target.collectionName,
    existingIndexName: existing?.name || null,
    existingKey: existing?.key ? clone(existing.key) : null,
    existingExpireAfterSeconds,
    expectedIndexName: target.indexName,
    expectedKey: clone(target.expectedKey),
    expectedExpireAfterSeconds: target.expectedExpireAfterSeconds,
    matches,
    totalIndexCount: indexList.length,
    unexpectedSameKeyIndexNames: unexpectedSameKeyIndexes.map((index) => index.name),
    namedIndexKeyMatches: namedIndex ? keysEqual(namedIndex.key, target.expectedKey) : null,
  };
}

async function auditNewsPulseTtlIndexes(db, options = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('MongoDB db handle is required');
  const targets = options.targets || TARGET_TTL_INDEXES;
  const databaseName = db.databaseName || db.s?.namespace?.db || db.namespace || null;
  const collections = [];

  for (const target of targets) {
    const collection = db.collection(target.collectionName);
    const indexes = await listCollectionIndexes(collection);
    collections.push(summarizeTargetIndex(target, indexes));
  }

  return { databaseName, collections };
}

function assertRepairable(summary, target) {
  if (summary.unexpectedSameKeyIndexNames.length) {
    throw new Error(`${target.collectionName}: unexpected expiresAt index name conflict: ${summary.unexpectedSameKeyIndexNames.join(', ')}`);
  }
  if (summary.existingIndexName && summary.existingIndexName !== target.indexName) {
    throw new Error(`${target.collectionName}: expected index name ${target.indexName}, found ${summary.existingIndexName}`);
  }
  if (summary.existingIndexName === target.indexName && summary.namedIndexKeyMatches === false) {
    throw new Error(`${target.collectionName}: ${target.indexName} key differs from expected { expiresAt: 1 }`);
  }
}

async function verifyFinalIndex(collection, target) {
  const indexes = await listCollectionIndexes(collection);
  const summary = summarizeTargetIndex(target, indexes);
  if (!summary.matches) {
    throw new Error(`${target.collectionName}: final TTL index verification failed`);
  }
  return summary;
}

async function repairOneTtlIndex(db, target, options = {}) {
  const dryRun = options.apply !== true;
  const collection = db.collection(target.collectionName);
  const beforeIndexes = await listCollectionIndexes(collection);
  const before = summarizeTargetIndex(target, beforeIndexes);
  assertRepairable(before, target);

  if (before.matches) {
    return { collectionName: target.collectionName, action: 'none', dryRun, before, after: before };
  }

  if (dryRun) {
    return { collectionName: target.collectionName, action: 'would-collMod', dryRun, before, after: null };
  }

  let action = 'collMod';
  try {
    await db.command({
      collMod: target.collectionName,
      index: {
        name: target.indexName,
        expireAfterSeconds: target.expectedExpireAfterSeconds,
      },
    });
  } catch (error) {
    if (!isUnsupportedCollModError(error)) throw error;
    action = 'drop-create';
    await collection.dropIndex(target.indexName);
    await collection.createIndex(
      clone(target.expectedKey),
      { name: target.indexName, expireAfterSeconds: target.expectedExpireAfterSeconds },
    );
  }

  const after = await verifyFinalIndex(collection, target);
  return { collectionName: target.collectionName, action, dryRun, before, after };
}

async function repairNewsPulseTtlIndexes(db, options = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('MongoDB db handle is required');
  const targets = options.targets || TARGET_TTL_INDEXES;
  const databaseName = db.databaseName || db.s?.namespace?.db || db.namespace || null;
  const results = [];

  for (const target of targets) {
    results.push(await repairOneTtlIndex(db, target, options));
  }

  return { databaseName, dryRun: options.apply !== true, results };
}

module.exports = {
  TARGET_TTL_INDEXES,
  auditNewsPulseTtlIndexes,
  keysEqual,
  repairNewsPulseTtlIndexes,
  summarizeTargetIndex,
};