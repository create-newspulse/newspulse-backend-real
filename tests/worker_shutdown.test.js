require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const backgroundTasks = require('../lib/backgroundTasks');
const { createBackgroundTasks } = backgroundTasks;
const { shutdownTimeout, shutdownAdmission, installGracefulShutdown } = require('../lib/gracefulShutdown');
const cleanup = require('../services/broadcastCleanup');
const monitoring = require('../services/newsPulseEngineMonitoringService');
const { startCanonicalLatestPrewarm } = require('../lib/publicNewsPrewarm');
const { addClient, closeBroadcastClients } = require('../services/broadcastSse.service');

const quiet = { info() {}, warn() {}, error() {} };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function runtime(options = {}) {
  const tasks = options.tasks || createBackgroundTasks();
  const processRef = new EventEmitter();
  const server = new EventEmitter();
  const events = [];
  let closeCallback;
  server.close = callback => { events.push('server.close'); closeCallback = callback; };
  server.closeIdleConnections = () => { events.push('server.idle'); };
  const shutdown = installGracefulShutdown({
    server, tasks, processRef, logger: quiet,
    closeDatabase: async () => { events.push('database.close'); },
    closeRedis: async () => { events.push('redis.close'); },
    exit: code => { events.push(`exit.${code}`); },
    ...options,
  });
  return { tasks, processRef, server, events, shutdown, finishRequests: () => closeCallback() };
}

test('shutdown has the approved configurable 25000ms default', () => {
  assert.equal(shutdownTimeout({}), 25_000);
  assert.equal(shutdownTimeout({ SHUTDOWN_TIMEOUT_MS: '18000' }), 18_000);
});

test('worker admission defaults to enabled and accepts only explicit boolean settings', () => {
  assert.equal(backgroundTasks.isBackgroundWorkersEnabled({}), true);
  assert.equal(backgroundTasks.isBackgroundWorkersEnabled({ BACKGROUND_WORKERS_ENABLED: 'true' }), true);
  assert.equal(backgroundTasks.isBackgroundWorkersEnabled({ BACKGROUND_WORKERS_ENABLED: ' FALSE ' }), false);
  for (const value of ['', ' ', '0', '1', 'disabled', 'tru', 'no']) {
    assert.throws(() => backgroundTasks.isBackgroundWorkersEnabled({ BACKGROUND_WORKERS_ENABLED: value }),
      /BACKGROUND_WORKERS_ENABLED must be true or false/);
  }
});

test('paused worker starters register no timers or triggers and keep request work admitted', async context => {
  const previous = process.env.BACKGROUND_WORKERS_ENABLED;
  process.env.BACKGROUND_WORKERS_ENABLED = 'false';
  context.after(() => {
    if (previous === undefined) delete process.env.BACKGROUND_WORKERS_ENABLED;
    else process.env.BACKGROUND_WORKERS_ENABLED = previous;
  });
  context.mock.method(global, 'setInterval', () => assert.fail('Paused workers must not register intervals'));
  context.mock.method(global, 'setTimeout', () => assert.fail('Paused workers must not register timeouts'));
  assert.equal(cleanup.startBroadcastCleanupJob(), undefined);
  assert.equal(require('../services/publishAsyncTranslation.service').startPublishTranslationWorker(), undefined);
  assert.deepEqual(monitoring.startNewsPulseEngineMonitoring({
    env: { NODE_ENV: 'production', BACKGROUND_WORKERS_ENABLED: 'false', NEWS_PULSE_MONITORING_ENABLED: 'true' },
    healthService: () => assert.fail('Paused monitoring must not run'),
  }), { started: false, reason: 'disabled' });
  assert.equal(monitoring.getMonitoringStatus().enabled, false);
  const mongo = new EventEmitter();
  mongo.readyState = 1;
  const redis = new EventEmitter();
  const stop = startCanonicalLatestPrewarm({
    mongo, redis, redisReady: () => true,
    refresh: () => assert.fail('Paused prewarm must not run'),
  });
  mongo.emit('connected');
  redis.emit('ready');
  assert.equal(mongo.listenerCount('connected'), 0);
  assert.equal(redis.listenerCount('ready'), 0);
  await stop();
  assert.equal(backgroundTasks.closing, false);
  assert.equal(await backgroundTasks.run('request-follow-up', () => 'completed'), 'completed');
});

for (const value of ['0', '-1', 'NaN', 'Infinity', '12ms', '1.5', ' ', '2147483648', '9007199254740991']) {
  test(`invalid shutdown budget ${JSON.stringify(value)} fails explicitly`, () => {
    assert.throws(() => shutdownTimeout({ SHUTDOWN_TIMEOUT_MS: value }), /positive integer/);
  });
}

test('shutdown stops admission immediately but does not abort accepted background work', async () => {
  const tasks = createBackgroundTasks();
  let stops = 0;
  tasks.registerStop(() => { stops += 1; });
  const first = tasks.beginShutdown();
  assert.equal(tasks.closing, true);
  assert.equal(tasks.signal.aborted, false);
  assert.equal(stops, 1);
  assert.equal(tasks.beginShutdown(), first);
  await first;
  await assert.rejects(tasks.run('not-admitted', () => assert.fail('Work must not start')), { code: 'WORKER_SHUTDOWN' });
  assert.throws(() => tasks.registerStop(() => {}), { code: 'WORKER_SHUTDOWN' });
});

test('draining tracks accepted follow-ups added after shutdown begins', async () => {
  const tasks = createBackgroundTasks();
  const first = deferred();
  const followup = deferred();
  tasks.track('accepted', first.promise.then(() => {
    tasks.track('followup', followup.promise);
  }));
  await tasks.beginShutdown();
  let idle = false;
  const drained = tasks.waitForIdle().then(() => { idle = true; });
  first.resolve();
  await turn();
  assert.equal(idle, false);
  assert.deepEqual(tasks.pending, ['followup']);
  followup.resolve();
  await drained;
  assert.equal(idle, true);
});

test('stop errors do not prevent other workers from receiving shutdown', async () => {
  const tasks = createBackgroundTasks();
  let stopped = false;
  tasks.registerStop(() => { throw new Error('Synthetic stop failure'); });
  tasks.registerStop(() => { stopped = true; });
  await assert.rejects(tasks.beginShutdown(), AggregateError);
  assert.equal(stopped, true);
});

test('SIGTERM and SIGINT share one drain and close resources only after accepted work', async () => {
  const fixture = runtime();
  const work = deferred();
  fixture.tasks.track('translation.job', work.promise);
  let stopped = 0;
  fixture.tasks.registerStop(() => { stopped += 1; });
  fixture.processRef.emit('SIGTERM');
  fixture.processRef.emit('SIGINT');
  const first = fixture.shutdown();
  assert.equal(fixture.shutdown(), first);
  assert.equal(stopped, 1);
  fixture.finishRequests();
  await turn();
  assert.equal(fixture.events.includes('database.close'), false);
  work.resolve();
  assert.equal(await first, 0);
  assert.deepEqual(fixture.events, ['server.close', 'server.idle', 'database.close', 'redis.close', 'exit.0']);
  assert.equal(fixture.processRef.listenerCount('SIGTERM'), 0);
  assert.equal(fixture.processRef.listenerCount('SIGINT'), 0);
});

test('HTTP request draining is a separate barrier from background task completion', async () => {
  const fixture = runtime();
  const work = deferred();
  fixture.tasks.track('accepted', work.promise);
  const done = fixture.shutdown();
  work.resolve();
  await turn();
  assert.equal(fixture.events.includes('database.close'), false);
  fixture.finishRequests();
  assert.equal(await done, 0);
});

test('a stop error is reported after draining rather than prematurely abandoning accepted work', async () => {
  const fixture = runtime();
  const work = deferred();
  fixture.tasks.registerStop(() => { throw new Error('Synthetic stop failure'); });
  fixture.tasks.track('accepted', work.promise);
  const done = fixture.shutdown();
  fixture.finishRequests();
  await turn();
  assert.equal(fixture.events.some(value => value.startsWith('exit.')), false);
  work.resolve();
  assert.equal(await done, 1);
  assert.ok(fixture.events.includes('database.close'));
  assert.ok(fixture.events.includes('redis.close'));
});

test('the exact default deadline aborts unfinished work and destroys lingering sockets', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = runtime();
  const work = deferred();
  fixture.tasks.track('translation.job', work.promise);
  const socket = new EventEmitter();
  let destroyed = 0;
  socket.destroy = () => { destroyed += 1; socket.emit('close'); };
  fixture.server.emit('connection', socket);
  const done = fixture.shutdown();
  context.mock.timers.tick(24_999);
  await turn();
  assert.equal(fixture.tasks.signal.aborted, false);
  context.mock.timers.tick(1);
  assert.equal(await done, 1);
  assert.equal(fixture.tasks.signal.aborted, true);
  assert.equal(destroyed, 1);
  assert.deepEqual(fixture.tasks.pending, ['translation.job']);
  assert.equal(fixture.events.includes('database.close'), false);
  work.resolve();
  fixture.finishRequests();
  await turn();
});

test('shutdown admission keeps normal responses and returns an explicit no-store 503 only while draining', async () => {
  const tasks = createBackgroundTasks();
  const app = express();
  app.use(shutdownAdmission(tasks));
  app.get('/work', (_req, res) => res.json({ ok: true }));
  assert.equal((await request(app).get('/work')).status, 200);
  await tasks.beginShutdown();
  const denied = await request(app).get('/work');
  assert.equal(denied.status, 503);
  assert.equal(denied.body.code, 'SERVER_SHUTTING_DOWN');
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.equal(denied.headers.connection, 'close');
  assert.equal(denied.headers['retry-after'], '1');
});

test('broadcast cleanup starts once, retains its cutoff, and drains its in-flight delete', async context => {
  const previousReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const gate = deferred();
  context.after(async () => { gate.resolve(); await cleanup.stopBroadcastCleanupJob(); mongoose.connection.readyState = previousReady; });
  const now = Date.now();
  context.mock.method(Date, 'now', () => now);
  let calls = 0;
  context.mock.method(require('../models/BroadcastItem'), 'deleteMany', async filter => {
    calls += 1;
    assert.equal(filter.createdAt.$lt.getTime(), now - 86_400_000);
    await gate.promise;
    return { acknowledged: true, deletedCount: 2 };
  });
  const timer = cleanup.startBroadcastCleanupJob();
  assert.equal(cleanup.startBroadcastCleanupJob(), timer);
  await turn();
  assert.equal(calls, 1);
  let drained = false;
  const stop = cleanup.stopBroadcastCleanupJob().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  gate.resolve();
  await stop;
  assert.equal(calls, 1);
});

test('monitoring shutdown waits for its active check and cancels future scheduled runs', async context => {
  const gate = deferred();
  let calls = 0;
  context.after(async () => { gate.resolve({ checks: [] }); await monitoring.stopNewsPulseEngineMonitoring(); });
  monitoring.startNewsPulseEngineMonitoring({
    env: { NODE_ENV: 'production' }, logger: quiet,
    healthService: async () => { calls += 1; return gate.promise; },
  });
  await turn();
  assert.equal(calls, 1);
  let drained = false;
  const stop = monitoring.stopNewsPulseEngineMonitoring().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  assert.equal(monitoring.getMonitoringStatus().running, false);
  gate.resolve({ checks: [] });
  await stop;
  assert.equal(calls, 1);
});

test('cache prewarm shutdown detaches triggers and waits for the active language', async context => {
  const mongo = new EventEmitter();
  mongo.readyState = 1;
  const redis = new EventEmitter();
  const gate = deferred();
  let calls = 0;
  const stop = startCanonicalLatestPrewarm({
    mongo, redis, redisReady: () => true, delayMs: 1,
    refresh: async () => { calls += 1; await gate.promise; return true; },
  });
  context.after(async () => { gate.resolve(); await stop(); });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  let drained = false;
  const done = stop().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  assert.equal(mongo.listenerCount('connected'), 0);
  assert.equal(redis.listenerCount('ready'), 0);
  gate.resolve();
  await done;
  assert.equal(calls, 1);
});

test('SSE shutdown closes every language stream and removes its heartbeat', context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const responses = ['en', 'hi', 'gu'].map(lang => {
    const res = new EventEmitter();
    res.status = () => res;
    res.setHeader = () => {};
    res.flushHeaders = () => {};
    res.flush = () => {};
    res.write = () => true;
    res.ended = 0;
    res.end = () => { res.ended += 1; res.emit('close'); };
    addClient({ res, lang });
    return res;
  });
  closeBroadcastClients();
  context.mock.timers.tick(25_000);
  assert.deepEqual(responses.map(res => res.ended), [1, 1, 1]);
});

test('registered automatic workers cannot restart after global shutdown begins', async context => {
  await backgroundTasks.beginShutdown();
  await backgroundTasks.waitForIdle();
  assert.equal(cleanup.startBroadcastCleanupJob(), null);
  assert.equal(monitoring.startNewsPulseEngineMonitoring({ env: { NODE_ENV: 'production' } }).reason, 'shutdown');
  const previousEnv = process.env.NODE_ENV;
  context.after(() => { process.env.NODE_ENV = previousEnv; });
  process.env.NODE_ENV = 'development';
  assert.equal(require('../services/publishAsyncTranslation.service').startPublishTranslationWorker(), undefined);
  const app = express();
  app.use(require('../routes/publicBroadcast.routes'));
  const response = await request(app).get('/stream');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'SERVER_SHUTTING_DOWN');
});
