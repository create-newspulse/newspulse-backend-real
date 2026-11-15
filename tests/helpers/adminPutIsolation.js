require('./publicNewsIsolation');

const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const dns = require('node:dns');
const mongoose = require('mongoose');

process.env.BACKGROUND_WORKERS_ENABLED = 'false';

const blocked = [];
const servers = new Set();
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
let connections = 0;

function refuse(operation) {
  blocked.push(operation);
  throw Object.assign(new Error(`Admin PUT fixture isolation blocked ${operation}`), {
    code: 'ADMIN_PUT_TEST_ISOLATION',
  });
}

function replace(object, name, implementation) {
  Object.defineProperty(object, name, { value: implementation, writable: false, configurable: false });
}

replace(mongoose.Connection.prototype, 'openUri', () => refuse('mongoose.openUri'));
replace(mongoose.mongo.MongoClient.prototype, 'connect', () => refuse('MongoClient.connect'));

// Supertest may contact only ephemeral HTTP servers created in this process, never existing localhost services.
const listen = net.Server.prototype.listen;
replace(net.Server.prototype, 'listen', function (...args) {
  const options = args[0] && typeof args[0] === 'object'
    ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  if (!(this instanceof http.Server) || options.port !== 0
    || ['path', 'fd', 'handle'].some(key => key in options)
    || options.host && !loopback.has(options.host)) return refuse('non-fixture listener');
  servers.add(this);
  this.once('close', () => servers.delete(this));
  return listen.apply(this, args);
});

const connect = net.Socket.prototype.connect;
replace(net.Socket.prototype, 'connect', function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: normalized[1] };
  const host = options.host || options.hostname;
  const owned = [...servers].some(server => {
    const address = server.address();
    return server.listening && address && typeof address === 'object' && address.port === Number(options.port);
  });
  if (options.path || !loopback.has(host) || !owned) return refuse('non-fixture connection');
  connections += 1;
  return connect.apply(this, args);
});

for (const api of [dns, dns.promises]) {
  const lookup = api.lookup;
  replace(api, 'lookup', function (host, ...args) {
    if (!loopback.has(host)) return refuse('external DNS lookup');
    return lookup.call(this, host, ...args);
  });
  for (const name of Object.keys(api).filter(key => key.startsWith('resolve') || key === 'reverse' || key === 'lookupService')) {
    replace(api, name, () => refuse(`dns.${name}`));
  }
  replace(api, 'Resolver', function () { return refuse('DNS resolver'); });
}
replace(require('node:dgram'), 'createSocket', () => refuse('UDP socket'));
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  replace(require('node:child_process'), name, () => refuse(`child_process.${name}`));
}
replace(require('node:worker_threads'), 'Worker', function () { return refuse('worker thread'); });

module.exports = {
  snapshot: () => ({ blocked: [...blocked], connections, listeners: [...servers].filter(server => server.listening).length }),
  assertNoSideEffects() {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.BACKGROUND_WORKERS_ENABLED, 'false');
    assert.equal(process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS, 'false');
    assert.deepEqual(blocked, [], 'no attempted database, external-service or worker activity');
    assert.equal([...servers].some(server => server.listening), false, 'all fixture HTTP servers closed');
    assert.deepEqual(require('../../lib/backgroundTasks').pending, []);
  },
};
