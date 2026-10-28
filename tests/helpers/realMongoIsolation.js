const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

if (process.env.NP_REAL_MONGO_TESTS !== '1') {
  throw new Error('Real MongoDB tests require explicit NP_REAL_MONGO_TESTS=1 approval.');
}

const systemVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT',
]);
for (const name of Object.keys(process.env)) {
  if (!systemVariables.has(name.toUpperCase())) delete process.env[name];
}
process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';
process.env.EMAIL_MODE = 'stub';

const URI = 'mongodb://127.0.0.1:27027/np_integration_sandbox?replicaSet=rs0&directConnection=true';
const DATABASE = 'np_integration_sandbox';
const root = path.resolve(__dirname, '..', '..');
const runId = crypto.randomUUID().replace(/-/g, '');
const prefix = `np_tx_${runId}_`;
const collections = new Set();
const violations = [];
const commands = [];
const pendingCommands = new Map();
let initialCollections;
let verified = false;

function refuse(reason) {
  violations.push(reason);
  throw Object.assign(new Error(`Real MongoDB isolation refused: ${reason}`), { code: 'NP_TEST_ISOLATION' });
}

function checkFile(file) {
  const filename = file instanceof URL ? file.pathname : Buffer.isBuffer(file) ? file.toString() : file;
  if (typeof filename === 'string' && /^\.env(?:\.|$)/i.test(path.basename(filename))) {
    refuse('environment-file access');
  }
}
for (const [object, names] of [
  [fs, ['readFileSync', 'readFile', 'openSync', 'open']],
  [fs.promises, ['readFile', 'open']],
]) {
  for (const name of names) {
    const original = object[name];
    object[name] = function (file, ...args) {
      checkFile(file);
      return original.call(this, file, ...args);
    };
  }
}

const load = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved === path.join(root, 'server.js') || request === 'node-cron'
    || resolved.startsWith(path.join(root, 'jobs') + path.sep)) {
    refuse('server or background-job import');
  }
  return load.apply(this, arguments);
};
const dotenv = require('dotenv');
dotenv.config = dotenv.configDotenv = () => refuse('dotenv loading');

const net = require('node:net');
const connectSocket = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
  if (options.path || options.host !== '127.0.0.1' || Number(options.port) !== 27027) {
    refuse('non-approved socket');
  }
  return connectSocket.apply(this, args);
};
for (const name of ['node:http', 'node:https']) {
  const http = require(name);
  http.request = http.get = () => refuse('HTTP integration');
}
require('node:tls').connect = () => refuse('TLS integration');
require('node:dgram').createSocket = () => refuse('UDP integration');
global.fetch = () => refuse('fetch integration');
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => refuse('child process');
}

const parsed = new URL(URI);
assert.equal(parsed.protocol, 'mongodb:');
assert.equal(parsed.hostname, '127.0.0.1');
assert.equal(parsed.port, '27027');
assert.equal(parsed.pathname, `/${DATABASE}`);
assert.equal(parsed.username + parsed.password + parsed.hash, '');
assert.deepEqual([...parsed.searchParams], [['replicaSet', 'rs0'], ['directConnection', 'true']]);
assert.ok(require.resolve('mongoose').startsWith(path.join(root, 'node_modules') + path.sep));
const mongoose = require('mongoose');
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
mongoose.set('bufferCommands', false);
assert.equal(mongoose.modelNames().length, 0, 'Install isolation before importing application models');

function checkCollection(name) {
  if (!verified || !collections.has(name) || !name.startsWith(prefix)) refuse('unowned collection');
}

const guardedDatabases = new WeakSet();
const closingClients = new WeakSet();
const nativeClose = mongoose.mongo.MongoClient.prototype.close;
mongoose.mongo.MongoClient.prototype.close = async function (...args) {
  closingClients.add(this);
  try { return await nativeClose.apply(this, args); }
  finally { closingClients.delete(this); }
};
const nativeDb = mongoose.mongo.MongoClient.prototype.db;
mongoose.mongo.MongoClient.prototype.db = function (name, options) {
  // The driver closes its sessions through admin; this exposes no other database operations.
  if (name === 'admin' && closingClients.has(this)) {
    const admin = nativeDb.call(this, name, options);
    return {
      command(value, commandOptions) {
        if (Object.keys(value).length !== 1 || !Array.isArray(value.endSessions)
          || commandOptions?.noResponse !== true) refuse('non-session administrative operation');
        return admin.command(value, commandOptions);
      },
    };
  }
  if (name !== undefined && name !== DATABASE) refuse('different database');
  const db = nativeDb.call(this, name, options);
  if (db.databaseName !== DATABASE) refuse('different default database');
  if (guardedDatabases.has(db)) return db;
  guardedDatabases.add(db);
  for (const method of ['collection', 'createCollection', 'dropCollection']) {
    const original = db[method];
    db[method] = function (collection, ...args) {
      checkCollection(collection);
      return original.call(this, collection, ...args);
    };
  }
  db.dropDatabase = db.admin = db.renameCollection = () => refuse('database-wide operation');
  const command = db.command;
  db.command = function (value, ...args) {
    if (!value || !['hello', 'buildInfo'].includes(Object.keys(value)[0])) refuse('unapproved database command');
    return command.call(this, value, ...args);
  };
  return db;
};
const nativeConnect = mongoose.mongo.MongoClient.prototype.connect;
mongoose.mongo.MongoClient.prototype.connect = function (...args) {
  const options = this.options;
  if (this.s.url !== URI || options.dbName !== DATABASE || options.replicaSet !== 'rs0'
    || options.directConnection !== true || options.hosts.length !== 1
    || options.hosts[0].host !== '127.0.0.1' || options.hosts[0].port !== 27027
    || options.credentials || options.srvHost || options.proxyHost || options.tls) {
    refuse('different or ambiguous MongoDB configuration');
  }
  return nativeConnect.apply(this, args);
};

// Only collection names are isolated; models, validation, queries and sessions remain real.
const registerModel = mongoose.model;
mongoose.model = function (name, schema, collection, options) {
  if (!schema) return registerModel.apply(this, arguments);
  const originalName = collection || schema.options.collection || mongoose.pluralize()(name);
  const scopedName = `${prefix}${originalName}`;
  if (initialCollections?.includes(scopedName)) refuse('pre-existing collection collision');
  collections.add(scopedName);
  schema.set('autoCreate', false);
  schema.set('autoIndex', false);
  return registerModel.call(this, name, schema, scopedName, options);
};

async function open() {
  // A local preflight should fail promptly rather than wait on an unavailable endpoint.
  await mongoose.connect(URI, {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, monitorCommands: true,
  });
  const db = mongoose.connection.db;
  assert.equal(db.databaseName, DATABASE);
  const hello = await db.command({ hello: 1 });
  const build = await db.command({ buildInfo: 1 });
  assert.equal(build.version.split('.')[0], '7');
  assert.equal(hello.setName, 'rs0');
  assert.equal(hello.isWritablePrimary, true);
  assert.ok(hello.logicalSessionTimeoutMinutes > 0);
  const members = [...(hello.hosts || []), ...(hello.passives || []), ...(hello.arbiters || [])];
  assert.equal(members.length, 1);
  // Docker advertises its internal loopback port; directConnection pins every socket to 27027.
  assert.match(members[0], /^(127\.0\.0\.1|localhost|\[::1\]):(27017|27027)$/);
  initialCollections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
  verified = true;
  const client = mongoose.connection.getClient();
  client.on('commandStarted', event => {
    const record = {
      name: event.commandName,
      collection: event.command[event.commandName],
      transactional: event.command.autocommit === false,
      transaction: event.command.txnNumber?.toString(),
      session: event.command.lsid?.id?.toString('hex'),
      succeeded: false,
    };
    commands.push(record);
    pendingCommands.set(event.requestId, record);
  });
  client.on('commandSucceeded', event => {
    const record = pendingCommands.get(event.requestId);
    if (record) record.succeeded = true;
    pendingCommands.delete(event.requestId);
  });
  client.on('commandFailed', event => {
    const record = pendingCommands.get(event.requestId);
    if (record) record.errorCode = event.failure?.code;
    pendingCommands.delete(event.requestId);
  });
  return { version: build.version, primary: true, replicaSet: hello.setName, runId };
}

async function initializeModels() {
  for (const model of Object.values(mongoose.models)) {
    checkCollection(model.collection.name);
    await model.createCollection();
    // Preserve all uniqueness constraints; non-unique lookup indexes are outside this harness.
    for (const [keys, options] of model.schema.indexes()) {
      if (options.unique) await model.collection.createIndex(keys, options);
    }
  }
}

async function cleanup() {
  try {
    if (!verified) return { verified: false, removedCollections: 0 };
    const db = mongoose.connection.db;
    const current = await db.listCollections({}, { nameOnly: true }).toArray();
    const owned = current.filter(item => collections.has(item.name) && item.name.startsWith(prefix));
    for (const item of owned) await db.dropCollection(item.name);
    const remaining = await db.listCollections({}, { nameOnly: true }).toArray();
    assert.ok(remaining.every(item => !item.name.startsWith(prefix)), 'Run-owned collections must be removed');
    assert.deepEqual(remaining.map(item => item.name).sort(), [...initialCollections].sort(),
      'Unowned collection metadata must remain unchanged');
    return { verified: true, removedCollections: owned.length, remainingRunCollections: 0 };
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { mongoose, runId, commands, violations, open, initializeModels, cleanup };
