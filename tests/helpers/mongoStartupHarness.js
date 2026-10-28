require('./publicNewsIsolation');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');

const fixture = JSON.parse(process.argv[2]);
const root = path.resolve(__dirname, '..', '..');
const serverPath = path.join(root, 'server.js');
const databaseName = 'np_integration_sandbox';
const mongoUri = `mongodb://127.0.0.1:27027/${databaseName}`;
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: mongoUri,
  MONGODB_DBNAME: databaseName,
  EXIT_ON_DB_CONNECT_FAIL: '1',
  ADMIN_SEED_FOUNDER_EMAIL: 'startup-fixture@example.invalid',
  ADMIN_SEED_FOUNDER_PASSWORD: 'synthetic-startup-fixture-only',
});

const environmentKeys = new Set(['NODE_ENV', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL']);
function applyEnvironment(values = {}) {
  for (const [key, value] of Object.entries(values)) {
    assert.ok(environmentKeys.has(key), 'Only synthetic startup-mode settings may be supplied');
    process.env[key] = value;
  }
}
applyEnvironment(fixture.env);
require('dotenv').config = () => {
  applyEnvironment(fixture.dotenv);
  return { parsed: fixture.dotenv || {} };
};

const result = {
  violations: [],
  compiled: [],
  mongooseCalls: {},
  commands: {},
  syncModels: [],
  services: {},
  audits: [],
  warnings: [],
  errors: [],
  connections: 0,
  listens: 0,
};
const increment = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
function refuse(operation) {
  return () => {
    result.violations.push(operation);
    throw new Error(`Startup fixture blocked ${operation}`);
  };
}

// No real sockets, database connections, environment-file reads or writes are allowed.
require('node:net').Socket.prototype.connect = refuse('socket connection');
require('node:tls').connect = refuse('TLS connection');
require('node:dgram').createSocket = refuse('datagram socket');
for (const transport of [require('node:http'), require('node:https')]) {
  transport.request = refuse('HTTP request');
  transport.get = refuse('HTTP request');
}
global.fetch = refuse('fetch');
const dns = require('node:dns');
for (const method of ['lookup', 'resolve', 'resolveSrv', 'resolveTxt']) {
  dns[method] = refuse('DNS lookup');
  dns.promises[method] = refuse('DNS lookup');
}
const childProcess = require('node:child_process');
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  childProcess[method] = refuse('child process');
}
mongoose.Connection.prototype.openUri = refuse('database connection');
mongoose.mongo.MongoClient.prototype.connect = refuse('database connection');

function protectRead(original) {
  return function(file, ...args) {
    const name = path.basename(String(file));
    if (/^\.env(?:\.|$)/i.test(name) || /(?:service[-_]?account|credentials).*\.json$|\.(?:pem|key)$/i.test(name)) {
      return refuse('private configuration read')();
    }
    return original.call(this, file, ...args);
  };
}
for (const method of ['readFileSync', 'readFile', 'createReadStream']) {
  fs[method] = protectRead(fs[method]);
}
fs.promises.readFile = protectRead(fs.promises.readFile);
for (const method of ['writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename']) {
  fs[method] = refuse('filesystem write');
  fs[`${method}Sync`] = refuse('filesystem write');
  fs.promises[method] = refuse('filesystem write');
}
fs.createWriteStream = refuse('filesystem write');
fs.mkdirSync = () => undefined;
fs.promises.mkdir = async () => undefined;

console.log = () => {};
console.warn = message => { result.warnings.push(String(message)); };
console.error = message => { result.errors.push(String(message)); };

const intervals = [];
const timer = () => ({ unref() { return this; } });
global.setTimeout = timer;
global.setInterval = (callback, delay) => {
  intervals.push({ callback, delay });
  return timer();
};
require('node:timers').setTimeout = global.setTimeout;
require('node:timers').setInterval = global.setInterval;

const compile = mongoose.Model.compile;
mongoose.Model.compile = function(...args) {
  result.compiled.push({
    model: args[0],
    autoIndex: mongoose.get('autoIndex'),
    autoCreate: mongoose.get('autoCreate'),
  });
  return compile.apply(this, args);
};
for (const method of ['syncIndexes', 'ensureIndexes', 'createIndexes', 'cleanIndexes', 'createCollection']) {
  const original = mongoose.Model[method];
  mongoose.Model[method] = function(...args) {
    increment(result.mongooseCalls, method);
    if (method === 'syncIndexes') result.syncModels.push(this.modelName);
    return original.apply(this, args);
  };
}

const newsIndexes = [
  { name: '_id_', key: { _id: 1 } },
  ...Array.from({ length: 63 }, (_, index) => ({
    name: `synthetic_existing_${index}`,
    key: { [`syntheticField${index}`]: 1 },
  })),
];
const originalNewsIndexes = JSON.stringify(newsIndexes);
const collections = new Map();
function collection(name) {
  if (collections.has(name)) return collections.get(name);
  const indexes = name === 'news' ? newsIndexes : [{ name: '_id_', key: { _id: 1 } }];
  if (['news_pulse_incidents', 'news_pulse_alerts'].includes(name) && !fixture.ttlMismatch) {
    indexes.push({ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 });
  }
  const driverCollection = new Proxy({
    collectionName: name,
    indexes: async () => {
      result.audits.push(name);
      return indexes.slice();
    },
    listIndexes: () => ({ toArray: async () => indexes.slice() }),
    findOne: async () => null,
    createIndex: async (key, options = {}) => {
      increment(result.commands, 'createIndexes');
      const indexName = options.name || Object.entries(key).map(([field, order]) => `${field}_${order}`).join('_');
      if (!indexes.some(index => index.name === indexName)) indexes.push({ ...options, name: indexName, key });
      return indexName;
    },
    dropIndex: async indexName => {
      increment(result.commands, 'dropIndexes');
      const position = indexes.findIndex(index => index.name === indexName);
      if (position !== -1) indexes.splice(position, 1);
    },
  }, {
    get(target, key, receiver) {
      if (key === 'then') return undefined;
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return refuse(`unexpected database operation ${String(key)}`);
    },
  });
  collections.set(name, driverCollection);
  return driverCollection;
}

const db = {
  databaseName,
  collection,
  createCollection: async name => {
    increment(result.commands, 'create');
    return collection(name);
  },
  command: async command => {
    const name = Object.keys(command)[0];
    increment(result.commands, name);
    if (name === 'ping') return { ok: 1 };
    return refuse(`database command ${name}`)();
  },
};
mongoose.connect = async (uri, options) => {
  assert.equal(uri, mongoUri);
  assert.equal(options.dbName, databaseName);
  result.connections += 1;
  mongoose.connection.db = db;
  mongoose.connection.name = databaseName;
  mongoose.connection.onOpen();
  return mongoose;
};

const overrides = new Map();
const redisValues = new Map();
const redis = Object.assign(new EventEmitter(), {
  status: 'ready',
  get: async key => redisValues.get(key) || null,
  set: async (key, value) => { redisValues.set(key, value); return 'OK'; },
  del: async key => Number(redisValues.delete(key)),
  expire: async key => Number(redisValues.has(key)),
});
overrides.set(require.resolve(path.join(root, 'lib', 'redis')), {
  getRedisClient: () => redis,
  isRedisReady: () => true,
});
function stubService(relativePath, method, returnValue) {
  const filename = require.resolve(path.join(root, relativePath));
  const methods = overrides.get(filename) || {};
  methods[method] = () => {
    increment(result.services, method);
    return returnValue;
  };
  overrides.set(filename, methods);
}
stubService('lib/founderSeed', 'seedFounderFromEnvIfNeeded');
stubService('lib/publicNewsPrewarm', 'startCanonicalLatestPrewarm');
stubService('services/broadcastCleanup', 'startBroadcastCleanupJob');
stubService('services/publishAsyncTranslation.service', 'startPublishTranslationWorker');
stubService('services/newsPulseEngineMonitoringService', 'startNewsPulseEngineMonitoring', { started: true, intervalMs: 60000 });
stubService('services/scheduledPublication.service', 'publishDueScheduledArticles');
stubService('services/scheduledPublication.service', 'refreshDuePublicArticleVisibility');
stubService('utils/mailer', 'createAdsTransport', { sendMail: refuse('email delivery') });
const load = Module._load;
Module._load = function(request, parent, isMain) {
  const exported = load.call(this, request, parent, isMain);
  const methods = overrides.get(Module._resolveFilename(request, parent, isMain));
  if (methods) Object.assign(exported, methods);
  return exported;
};

require('express').application.listen = function(_options, callback) {
  result.listens += 1;
  process.nextTick(callback);
  return new EventEmitter();
};

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  if (result.connections) {
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function run() {
  const serverModule = new Module(serverPath, module);
  serverModule.paths = Module._nodeModulePaths(root);
  if (!fixture.imported) process.mainModule = serverModule;
  serverModule.load(serverPath);
  await settle();
  if (fixture.reconnect) {
    mongoose.connection.emit('disconnected');
    await settle();
  }

  const scheduler = intervals.filter(entry => entry.callback.name === '_publishScheduledTick');
  result.schedulers = scheduler.map(entry => entry.delay);
  for (const entry of scheduler) await entry.callback();
  await settle();

  const app = serverModule.exports;
  result.health = {};
  for (const routePath of ['/health', '/api/health', '/api/system/health']) {
    const layer = app._router.stack.find(entry => entry.route && entry.route.path === routePath);
    assert.ok(layer, `${routePath} remains registered`);
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await layer.route.stack[0].handle({}, response);
    result.health[routePath] = { status: response.statusCode, body: response.body };
  }
  result.mountedRoutes = {};
  for (const name of ['auth.routes', 'articles.routes', 'publicNews.routes', 'ads.routes', 'liveTv.routes', 'adminNewsTranslations.routes']) {
    const router = require(path.join(root, 'routes', name));
    result.mountedRoutes[name] = app._router.stack.some(layer => layer.handle === router);
  }
  result.maintenanceImports = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(root, 'scripts') + path.sep));
  result.models = mongoose.modelNames();
  result.initializedModels = result.connections ? Object.values(mongoose.models).filter(model => model.$init).length : 0;
  result.newsIndexCount = newsIndexes.length;
  result.newsIndexesUnchanged = JSON.stringify(newsIndexes) === originalNewsIndexes;
  process.stdout.write(`STARTUP_POLICY_RESULT ${JSON.stringify(result)}\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
