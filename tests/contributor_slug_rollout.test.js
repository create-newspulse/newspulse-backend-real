const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { normalizeContributorSlugHistory } = require('../lib/contributorSlugHistory');

process.env.NODE_ENV = 'test';
const Contributor = require('../models/Contributor');
const { HISTORY_INDEX, contributorSlugCapabilities, initializeLegacyContributorHistory } = require('../lib/contributorSlugReadiness');

function readyIndexes() {
  return [{ name: 'slug_1', key: { slug: 1 }, unique: true }, { key: HISTORY_INDEX.key, ...HISTORY_INDEX.options }];
}

test('rename readiness requires explicit flag, both exact indexes and complete reservations', async () => {
  const enabled = { PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED: 'true' };
  const Model = { collection: {
    listIndexes: () => ({ toArray: async () => readyIndexes() }),
    findOne: async () => null,
  } };
  assert.deepEqual(await contributorSlugCapabilities({}, {}), { slugRename: false });
  assert.deepEqual(await contributorSlugCapabilities(Model, enabled), { slugRename: true });
  Model.collection.findOne = async () => ({ _id: 'legacy' });
  assert.deepEqual(await contributorSlugCapabilities(Model, enabled), { slugRename: false });
  Model.collection.listIndexes = () => ({ toArray: async () => readyIndexes().slice(0, 1) });
  assert.deepEqual(await contributorSlugCapabilities(Model, enabled), { slugRename: false });
  Model.collection.listIndexes = () => { throw new Error('unavailable'); };
  assert.deepEqual(await contributorSlugCapabilities(Model, enabled), { slugRename: false });
});

test('legacy initialization only reserves a clean unchanged canonical slug with a conditional write', async () => {
  const legacy = { _id: 'legacy', slug: 'writer-name' };
  let writes = 0;
  const Model = {
    exists: async () => null,
    findOneAndUpdate: async (filter, update) => {
      writes += 1;
      assert.deepEqual(filter, { ...legacy, slugHistory: { $exists: false } });
      assert.deepEqual(update, { $set: { slugHistory: ['writer-name'] } });
      return { ...legacy, ...update.$set };
    },
  };
  assert.deepEqual((await initializeLegacyContributorHistory(Model, legacy)).slugHistory, ['writer-name']);
  Model.exists = async () => ({ _id: 'conflict' });
  assert.equal(await initializeLegacyContributorHistory(Model, legacy), legacy);
  await initializeLegacyContributorHistory(Model, { ...legacy, slug: ' Writer ' });
  await initializeLegacyContributorHistory(Model, { ...legacy, slugHistory: null });
  assert.equal(writes, 1);
});

test('disabled rename and capability endpoint stay authenticated and never touch Contributor storage', async (context) => {
  const express = require('express');
  const request = require('supertest');
  const original = process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED;
  delete process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED;
  context.after(() => {
    if (original === undefined) delete process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED;
    else process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED = original;
  });
  for (const method of ['findById', 'exists', 'findOneAndUpdate']) context.mock.method(Contributor, method, () => assert.fail('No database access while disabled'));
  context.mock.method(Contributor.collection, 'listIndexes', () => assert.fail('No index access while disabled'));
  const app = express();
  app.use(express.json());
  app.use('/contributors', require('../routes/adminPulseDialogueContributors.routes'));
  const token = 'np.' + Buffer.from('admin@newspulse.ai:0').toString('base64');
  assert.equal((await request(app).get('/contributors/capabilities')).status, 401);
  const capability = await request(app).get('/contributors/capabilities').set('Authorization', 'Bearer ' + token);
  assert.equal(capability.headers['cache-control'], 'no-store');
  assert.deepEqual(capability.body, { ok: true, success: true, capabilities: { slugRename: false }, data: { capabilities: { slugRename: false } } });
  const result = await request(app).patch('/contributors/507f1f77bcf86cd799439a01/slug')
    .set('Authorization', 'Bearer ' + token).send({ slug: 'changed' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'CONTRIBUTOR_SLUG_RENAME_UNAVAILABLE');
});

test('Contributor production and Render schema disables implicit indexing without removing declarations', () => {
  for (const runtime of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', RENDER: 'true' }]) {
    const result = JSON.parse(execFileSync(process.execPath, ['-e',
      "const mongoose=require('mongoose'); mongoose.set('bufferCommands',false); mongoose.connection.createCollection=async()=>{throw new Error('Implicit collection creation');}; const Model=require('./models/Contributor'); Model.collection.createIndex=async()=>{throw new Error('Implicit index creation');}; Model.init().then(()=>console.log(JSON.stringify({autoIndex:Model.schema.options.autoIndex,autoCreate:Model.schema.options.autoCreate,indexes:Model.schema.indexes()}))).catch(()=>process.exit(1));"],
    { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, ...runtime }, encoding: 'utf8' }));
    assert.equal(result.autoIndex, false);
    assert.equal(result.autoCreate, false);
    assert.ok(result.indexes.some(([key, options]) => key.slug === 1 && options.unique));
    assert.ok(result.indexes.some(([key, options]) => key.slugHistory === 1 && options.unique));
  }
});

test('history normalizes strings before Mongoose casting and deduplicates reservations', async () => {
  const history = [' Writer-Name ', 'WRITER%2DNAME', '\uff37riter-Name', null, 123, {}, '', '!!!', 'Old Name'];
  assert.deepEqual(normalizeContributorSlugHistory(history, 'writer-name'), ['writer-name', 'old-name']);
  const doc = new Contributor({ canonicalName: 'Writer Name', slugHistory: history });
  await doc.validate();
  assert.deepEqual([...doc.slugHistory], ['writer-name', 'old-name']);
  const explicit = new Contributor({ canonicalName: 'Writer', slug: 'Writer Name!' });
  await explicit.validate();
  assert.equal(explicit.slug, 'writer-name');
  assert.deepEqual([...explicit.slugHistory], ['writer-name']);
});

test('legacy reads do not initialize history; legitimate document validation retains old and current slug', async () => {
  const doc = Contributor.hydrate({ canonicalName: 'Writer Name', slug: 'writer-name' });
  assert.equal(doc.slugHistory, undefined);
  doc.slug = 'new-name';
  await doc.validate();
  assert.deepEqual([...doc.slugHistory], ['writer-name', 'new-name']);
});

const { parseArgs, analyzeContributors, runRelease } = require('../scripts/contributor-slug-history-release');

function fakeCollection(initialRecords, initialIndexes = readyIndexes().slice(0, 1)) {
  const records = structuredClone(initialRecords);
  const indexes = structuredClone(initialIndexes);
  const calls = [];
  return {
    calls, records, indexes,
    listIndexes: () => ({ toArray: async () => structuredClone(indexes) }),
    options: async () => ({}),
    find: () => ({ limit() { return this; }, maxTimeMS() { return this; }, toArray: async () => structuredClone(records) }),
    findOne: async () => null,
    updateOne: async (filter, update) => {
      calls.push({ filter, update });
      assert.deepEqual(Object.keys(update), ['$set']);
      assert.deepEqual(Object.keys(update.$set), ['slugHistory']);
      const record = records.find(value => value._id === filter._id && value.slug === filter.slug);
      if (!record) return { matchedCount: 0 };
      Object.assign(record, update.$set);
      return { matchedCount: 1 };
    },
    createIndex: async (key, options) => {
      calls.push({ key, options });
      indexes.push({ key, ...options });
      return options.name;
    },
  };
}

test('release dry-run defaults to reads only, even for a proposed backfill or index action', async () => {
  assert.equal(parseArgs([]).action, 'audit');
  assert.equal(parseArgs([]).apply, false);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /INVALID_ACTION/);
  assert.throws(() => parseArgs(['--drop-index']), /UNKNOWN_ARGUMENT/);
  const collection = fakeCollection([{ _id: 'legacy', slug: 'writer-name' }]);
  for (const action of ['audit', 'backfill', 'create-index', 'verify']) {
    const result = await runRelease(collection, { action }, {});
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.counts.missingHistory, 1);
    assert.equal(result.counts.currentMissingFromHistory, 1);
    assert.equal(result.ready, false);
  }
  assert.deepEqual(collection.calls, []);
});

test('audit reports duplicates, malformed data, missing and cross-field reservations', () => {
  const records = [
    { _id: 'one', slug: 'writer', slugHistory: ['writer', 'past', 'past', null] },
    { _id: 'two', slug: 'writer', slugHistory: ['past'] },
    { _id: 'three', slug: 'past' },
    { _id: 'four', slug: null, slugHistory: 'invalid' },
    { _id: 'five', slug: 'other', slugHistory: [' PAST '] },
  ];
  const { report } = analyzeContributors(records, readyIndexes());
  assert.equal(report.counts.duplicateCurrentSlugs, 1);
  assert.equal(report.counts.duplicateHistoricalSlugs, 1);
  assert.equal(report.counts.currentHistoryConflicts, 2);
  assert.equal(report.counts.malformedHistories, 3);
  assert.equal(report.counts.missingHistory, 1);
  assert.equal(report.counts.currentMissingFromHistory, 4);
  assert.equal(report.counts.duplicateHistoryValues, 1);
  assert.equal(report.counts.invalidCurrentSlugs, 1);
  assert.equal(report.ready, false);
});

const authorizedApply = { apply: true, writersPaused: true, newVersionOnly: true };

test('conflicts prevent all backfill and index writes; writes require explicit rollout acknowledgements', async () => {
  for (const action of ['backfill', 'create-index']) {
    const collection = fakeCollection([{ _id: 'one', slug: 'same' }, { _id: 'two', slug: 'same' }]);
    await assert.rejects(runRelease(collection, { action, apply: true }, {}), /WRITE_SAFETY/);
    await assert.rejects(runRelease(collection, { action, ...authorizedApply }, {}), /PREFLIGHT_CONFLICTS/);
    await assert.rejects(runRelease(collection, { action, ...authorizedApply }, { PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED: 'true' }), /WRITE_SAFETY/);
    assert.deepEqual(collection.calls, []);
  }
});

test('backfill only initializes safe reservations; separate provisioning verifies both indexes', async () => {
  const collection = fakeCollection([{ _id: 'one', slug: 'writer' }, { _id: 'two', slug: 'second', slugHistory: ['earlier'] }]);
  await assert.rejects(runRelease(collection, { action: 'create-index', ...authorizedApply }, {}), /RESERVATIONS_INCOMPLETE/);
  assert.equal(collection.calls.length, 0);
  const backfill = await runRelease(collection, { action: 'backfill', ...authorizedApply }, {});
  assert.equal(backfill.initialized, 2);
  assert.equal(backfill.ready, false);
  assert.deepEqual(collection.records, [{ _id: 'one', slug: 'writer', slugHistory: ['writer'] },
    { _id: 'two', slug: 'second', slugHistory: ['earlier', 'second'] }]);
  assert.equal(collection.indexes.length, 1);
  const created = await runRelease(collection, { action: 'create-index', ...authorizedApply }, {});
  assert.equal(created.ready, true);
  assert.deepEqual(collection.calls[2], HISTORY_INDEX);
  const verified = await runRelease(collection, { action: 'verify' }, {});
  assert.equal(verified.ready, true);
  assert.equal(collection.calls.length, 3);
});

test('wrong index options and stale data stop explicit operations', async () => {
  const collection = fakeCollection([{ _id: 'one', slug: 'writer' }]);
  collection.indexes.push({ name: 'slugHistory_1', key: { slugHistory: 1 }, unique: false });
  await assert.rejects(runRelease(collection, { action: 'backfill', ...authorizedApply }, {}), /PREFLIGHT_CONFLICTS/);
  assert.equal(collection.calls.length, 0);
  collection.indexes.pop();
  collection.updateOne = async () => ({ matchedCount: 0 });
  await assert.rejects(runRelease(collection, { action: 'backfill', ...authorizedApply }, {}), /CONCURRENT_CONTRIBUTOR_CHANGE/);
});

test('ordinary profile update initializes legacy history without changing slug or accepting supplied history', async (context) => {
  const express = require('express');
  const request = require('supertest');
  const id = '507f1f77bcf86cd799439a01';
  const legacy = { _id: id, canonicalName: 'Writer Name', slug: 'writer-name' };
  context.mock.method(Contributor, 'findByIdAndUpdate', async (requestedId, update) => {
    assert.equal(requestedId, id);
    assert.deepEqual(update, { $set: { canonicalName: 'Changed Display Name' } });
    return { ...legacy, ...update.$set };
  });
  context.mock.method(Contributor, 'exists', async () => null);
  let reservations = 0;
  context.mock.method(Contributor, 'findOneAndUpdate', async (filter, update) => {
    reservations += 1;
    assert.deepEqual(filter, { _id: id, slug: 'writer-name', slugHistory: { $exists: false } });
    assert.deepEqual(update, { $set: { slugHistory: ['writer-name'] } });
    return { ...legacy, canonicalName: 'Changed Display Name', ...update.$set };
  });
  const app = express();
  app.use(express.json());
  app.use(require('../routes/adminPulseDialogueContributors.routes'));
  const token = 'np.' + Buffer.from('admin@newspulse.ai:0').toString('base64');
  const response = await request(app).patch('/' + id).set('Authorization', 'Bearer ' + token)
    .send({ canonicalName: 'Changed Display Name', slugHistory: ['untrusted'] });
  assert.equal(response.status, 200);
  assert.equal(response.body.contributor.slug, 'writer-name');
  assert.deepEqual(response.body.contributor.slugHistory, ['writer-name']);
  assert.equal(reservations, 1);
});

test('readiness rejects sparse, partial, nonunique, wrong-key and wrong-name indexes', () => {
  const { contributorIndexReadiness } = require('../lib/contributorSlugReadiness');
  for (const position of [0, 1]) {
    for (const patch of [{ unique: false }, { sparse: true }, { name: 'unexpected' }, { hidden: true }, { expireAfterSeconds: 0 },
      { key: { other: 1 } }, { collation: { locale: 'en', strength: 2 } }, { partialFilterExpression: { slug: { $exists: true } } }]) {
      const indexes = readyIndexes();
      indexes[position] = { ...indexes[position], ...patch };
      assert.equal(contributorIndexReadiness(indexes).ready, false);
    }
  }
});

test('malformed histories, cross-field conflicts and missing canonical index block every write action', async () => {
  for (const records of [
    [{ _id: 'one', slug: 'writer', slugHistory: [null] }],
    [{ _id: 'one', slug: 'writer', slugHistory: ['writer', 'writer'] }],
    [{ _id: 'one', slug: 'writer' }, { _id: 'two', slug: 'other', slugHistory: ['writer'] }],
  ]) {
    for (const action of ['backfill', 'create-index']) {
      const collection = fakeCollection(records);
      await assert.rejects(runRelease(collection, { action, ...authorizedApply }, {}), /PREFLIGHT_CONFLICTS/);
      assert.deepEqual(collection.calls, []);
    }
  }
  const collection = fakeCollection([{ _id: 'one', slug: 'writer' }], []);
  await assert.rejects(runRelease(collection, { action: 'backfill', ...authorizedApply }, {}), /PREFLIGHT_CONFLICTS/);
  assert.deepEqual(collection.calls, []);
});

test('history setter preserves scalar lookups, membership checks and rename compare-and-set query casting', () => {
  for (const filter of [
    { slugHistory: 'writer-name' },
    { slugHistory: { $in: ['writer-name', 'past-name'] } },
    { slugHistory: { $exists: false } },
    { slug: 'writer-name', $expr: { $eq: [{ $ifNull: ['$slugHistory', null] }, { $literal: ['writer-name'] }] } },
  ]) {
    assert.deepEqual(Contributor.findOne(structuredClone(filter)).cast(Contributor), filter);
  }
});