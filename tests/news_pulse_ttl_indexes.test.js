const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditNewsPulseTtlIndexes,
  repairNewsPulseTtlIndexes,
} = require('../lib/newsPulseTtlIndexes');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeCollection {
  constructor(name, indexes) {
    this.name = name;
    this.indexList = clone(indexes);
    this.calls = [];
  }

  async indexes() {
    return clone(this.indexList);
  }

  async dropIndex(name) {
    this.calls.push({ op: 'dropIndex', name });
    const index = this.indexList.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Error(`index not found: ${name}`);
    this.indexList.splice(index, 1);
    return { ok: 1 };
  }

  async createIndex(key, options) {
    this.calls.push({ op: 'createIndex', key: clone(key), options: clone(options) });
    this.indexList.push({ name: options.name, key: clone(key), expireAfterSeconds: options.expireAfterSeconds });
    return options.name;
  }
}

class FakeDb {
  constructor(collections, options = {}) {
    this.databaseName = options.databaseName || 'newspulse-test';
    this.collections = collections;
    this.commands = [];
    this.failCollMod = options.failCollMod || false;
    this.unauthorizedCollMod = options.unauthorizedCollMod || false;
  }

  collection(name) {
    const collection = this.collections[name];
    if (!collection) throw new Error(`unknown collection: ${name}`);
    return collection;
  }

  async command(command) {
    this.commands.push(clone(command));
    if (this.failCollMod) {
      const error = new Error('no such command: collMod');
      error.codeName = 'CommandNotFound';
      throw error;
    }
    if (this.unauthorizedCollMod) {
      const error = new Error(`user is not allowed to do action [collMod] on [test.${command.collMod}]`);
      error.code = 13;
      error.codeName = 'Unauthorized';
      throw error;
    }

    const collection = this.collection(command.collMod);
    const index = collection.indexList.find((entry) => entry.name === command.index.name);
    if (!index) throw new Error(`index not found: ${command.index.name}`);
    index.expireAfterSeconds = command.index.expireAfterSeconds;
    return { ok: 1 };
  }
}

function baseIndexes(ttlValue) {
  return [
    { name: '_id_', key: { _id: 1 } },
    { name: 'checkId_1', key: { checkId: 1 } },
    { name: 'expiresAt_1', key: { expiresAt: 1 }, ...(ttlValue === undefined ? {} : { expireAfterSeconds: ttlValue }) },
  ];
}

function makeDb({ incidentTtl, alertTtl, incidentIndexes, alertIndexes, failCollMod, unauthorizedCollMod } = {}) {
  return new FakeDb({
    news_pulse_incidents: new FakeCollection('news_pulse_incidents', incidentIndexes || baseIndexes(incidentTtl)),
    news_pulse_alerts: new FakeCollection('news_pulse_alerts', alertIndexes || baseIndexes(alertTtl)),
  }, { failCollMod, unauthorizedCollMod });
}

test('audit detects missing TTL option', async () => {
  const db = makeDb({ incidentTtl: undefined, alertTtl: 0 });
  const audit = await auditNewsPulseTtlIndexes(db);
  const incident = audit.collections.find((entry) => entry.collectionName === 'news_pulse_incidents');

  assert.equal(audit.databaseName, 'newspulse-test');
  assert.equal(incident.existingIndexName, 'expiresAt_1');
  assert.deepEqual(incident.existingKey, { expiresAt: 1 });
  assert.equal(incident.existingExpireAfterSeconds, null);
  assert.equal(incident.expectedExpireAfterSeconds, 0);
  assert.equal(incident.matches, false);
  assert.equal(incident.totalIndexCount, 3);
});

test('audit detects correct TTL option', async () => {
  const db = makeDb({ incidentTtl: 0, alertTtl: 0 });
  const audit = await auditNewsPulseTtlIndexes(db);

  assert.equal(audit.collections.length, 2);
  assert.ok(audit.collections.every((entry) => entry.matches === true));
});

test('repair rejects wrong expiresAt_1 index key', async () => {
  const db = makeDb({
    incidentIndexes: [
      { name: '_id_', key: { _id: 1 } },
      { name: 'expiresAt_1', key: { expiresAt: -1 } },
    ],
    alertTtl: 0,
  });

  await assert.rejects(
    () => repairNewsPulseTtlIndexes(db, { apply: true }),
    /key differs from expected/
  );
});

test('dry-run makes zero mutations', async () => {
  const db = makeDb({ incidentTtl: undefined, alertTtl: undefined });
  const result = await repairNewsPulseTtlIndexes(db);

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.results.map((entry) => entry.action), ['would-collMod', 'would-collMod']);
  assert.equal(db.commands.length, 0);
  assert.equal(db.collection('news_pulse_incidents').calls.length, 0);
  assert.equal(db.collection('news_pulse_alerts').calls.length, 0);
});

test('apply changes only the approved TTL index and preserves unrelated indexes', async () => {
  const db = makeDb({ incidentTtl: undefined, alertTtl: undefined });
  const incidentBefore = await db.collection('news_pulse_incidents').indexes();
  const result = await repairNewsPulseTtlIndexes(db, { apply: true });
  const incidentAfter = await db.collection('news_pulse_incidents').indexes();

  assert.equal(result.dryRun, false);
  assert.deepEqual(result.results.map((entry) => entry.action), ['collMod', 'collMod']);
  assert.equal(db.commands.length, 2);
  assert.deepEqual(
    incidentAfter.filter((entry) => entry.name !== 'expiresAt_1'),
    incidentBefore.filter((entry) => entry.name !== 'expiresAt_1')
  );
  assert.equal(incidentAfter.find((entry) => entry.name === 'expiresAt_1').expireAfterSeconds, 0);
  assert.ok(result.results.every((entry) => entry.after.matches === true));
});

test('apply falls back to guarded drop and recreate when collMod is unsupported', async () => {
  const db = makeDb({ incidentTtl: undefined, alertTtl: 0, failCollMod: true });
  const result = await repairNewsPulseTtlIndexes(db, { apply: true });
  const incident = db.collection('news_pulse_incidents');
  const alert = db.collection('news_pulse_alerts');

  assert.equal(result.results[0].action, 'drop-create');
  assert.equal(result.results[1].action, 'none');
  assert.deepEqual(incident.calls.map((call) => call.op), ['dropIndex', 'createIndex']);
  assert.deepEqual(alert.calls, []);
  assert.equal((await incident.indexes()).find((entry) => entry.name === 'expiresAt_1').expireAfterSeconds, 0);
});

test('apply falls back to guarded drop and recreate when collMod is unauthorized', async () => {
  const db = makeDb({ incidentTtl: undefined, alertTtl: undefined, unauthorizedCollMod: true });
  const result = await repairNewsPulseTtlIndexes(db, { apply: true });
  const incident = db.collection('news_pulse_incidents');
  const alert = db.collection('news_pulse_alerts');

  assert.deepEqual(result.results.map((entry) => entry.action), ['drop-create', 'drop-create']);
  assert.deepEqual(incident.calls.map((call) => call.op), ['dropIndex', 'createIndex']);
  assert.deepEqual(alert.calls.map((call) => call.op), ['dropIndex', 'createIndex']);
  assert.equal((await incident.indexes()).find((entry) => entry.name === 'expiresAt_1').expireAfterSeconds, 0);
  assert.equal((await alert.indexes()).find((entry) => entry.name === 'expiresAt_1').expireAfterSeconds, 0);
  assert.ok(result.results.every((entry) => entry.after.matches === true));
});

test('repair stops on unexpected index-name conflict', async () => {
  const db = makeDb({
    incidentIndexes: [
      { name: '_id_', key: { _id: 1 } },
      { name: 'expiresAt_1', key: { expiresAt: 1 } },
      { name: 'legacy_expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
    alertTtl: 0,
  });

  await assert.rejects(
    () => repairNewsPulseTtlIndexes(db, { apply: true }),
    /unexpected expiresAt index name conflict/
  );
});