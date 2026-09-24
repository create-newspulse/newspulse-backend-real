const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const express = require('express');
const request = require('supertest');

class FakeRedis {
  constructor() {
    this.entries = new Map();
    this.now = 0;
  }

  purge(key) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now) this.entries.delete(key);
  }

  async get(key) {
    this.purge(key);
    return this.entries.get(key)?.value || null;
  }

  async set(key, value, ...args) {
    const ttlIndex = args.indexOf('EX');
    const ttl = ttlIndex >= 0 ? Number(args[ttlIndex + 1]) : 0;
    const nx = args.includes('NX');
    this.purge(key);
    if (nx && this.entries.has(key)) return null;
    this.entries.set(key, { value, expiresAt: this.now + (ttl * 1000) });
    return 'OK';
  }

  async del(keys) {
    const targetKeys = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of targetKeys) {
      this.purge(key);
      if (this.entries.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async scan(_cursor, _match, pattern) {
    const prefix = pattern.slice(0, -1);
    const keys = [];
    for (const key of this.entries.keys()) {
      this.purge(key);
      if (key.startsWith(prefix)) keys.push(key);
    }
    return ['0', keys];
  }

  async eval(_script, _keyCount, key, token) {
    return (await this.get(key)) === token ? this.del([key]) : 0;
  }

  advance(milliseconds) {
    this.now += milliseconds;
  }
}

function loadCache(fakeRedis, state = { ready: true }) {
  const redisPath = require.resolve('../lib/redis');
  const cachePath = require.resolve('../lib/cache');
  const originalRedis = require.cache[redisPath];
  delete require.cache[cachePath];
  require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: {
      getRedisClient: () => fakeRedis,
      isRedisReady: () => state.ready,
    },
  };
  return {
    cache: require('../lib/cache'),
    restore() {
      delete require.cache[cachePath];
      if (originalRedis) require.cache[redisPath] = originalRedis;
      else delete require.cache[redisPath];
    },
  };
}

function makeApp(cache, handler, options = {}) {
  const app = express();
  app.get('/cached', cache.createJsonCacheMiddleware({
    ttlSeconds: 100,
    coldCacheWaitMs: options.coldCacheWaitMs || 180,
    coldCachePollMs: 15,
    buildKey: () => 'np:v1:test:cache',
    shouldCache: ({ statusCode }) => statusCode === 200,
  }), handler);
  return app;
}

function capturePublicNewsCacheKey(t) {
  const loaded = loadCache(new FakeRedis());
  const routePath = require.resolve('../routes/publicNews.routes');
  const originalRoute = require.cache[routePath];
  const originalFactory = loaded.cache.createJsonCacheMiddleware;
  let buildKey;
  loaded.cache.createJsonCacheMiddleware = (options) => {
    buildKey = options.buildKey;
    return originalFactory(options);
  };
  try {
    delete require.cache[routePath];
    require(routePath);
  } finally {
    loaded.cache.createJsonCacheMiddleware = originalFactory;
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
  }
  const mongoose = require('mongoose');
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => {
    mongoose.connection.readyState = previousState;
    loaded.restore();
  });
  return (query, headers = {}) => buildKey({ query, headers });
}

test('public-news cache keys isolate category and latest limits', (t) => {
  const key = capturePublicNewsCacheKey(t);
  assert.notEqual(key({ category: 'national', lang: 'en', limit: '30' }), key({ category: 'national', lang: 'en', limit: '90' }));
  assert.notEqual(key({ lang: 'gu', limit: '8' }), key({ lang: 'gu', limit: '40' }));
});

test('public-news keys isolate every active category filter and locale', (t) => {
  const key = capturePublicNewsCacheKey(t);
  const base = { category: 'national', lang: 'en', page: '1', limit: '30' };
  const variants = [
    {}, { category: 'sports' }, { lang: 'hi' }, { lang: 'gu' }, { page: '2' }, { limit: '40' },
    { track: 'campus-buzz' }, { topic: 'politics' }, { state: 'Gujarat' }, { q: 'news' },
    { founderOnly: 'true' }, { type: 'video' },
  ].map((variant) => key({ ...base, ...variant }));
  assert.equal(new Set(variants).size, variants.length);
  assert.notEqual(key(base), key({ lang: 'en', limit: '30' }));
});

test('equivalent effective list requests produce identical keys', (t) => {
  const key = capturePublicNewsCacheKey(t);
  assert.equal(
    key({ category: 'SCIENCE_AND_TECHNOLOGY', lang: 'Hindi', page: '01', limit: '999', track: 'Campus Buzz', topic: ' Politics ', state: ' GUJARAT ', q: ' NEWS ', founderOnly: 'YES', type: ' VIDEO ' }),
    key({ category: 'tech', language: 'hi-IN', page: '1', limit: '100', track: 'campusbuzz', topic: 'politics', locationState: 'gujarat', q: 'news', founderOnly: '1', type: 'video' })
  );
  assert.equal(key({ category: 'national' }), key({ category: 'national', lang: 'Gujarati', limit: '30', page: '1' }));
  assert.equal(key({ lang: 'invalid', language: 'Hindi' }), key({ lang: 'hi' }));
  assert.equal(key({}, { 'x-language': 'Gujarati' }), key({ lang: 'gu' }));
  assert.equal(key({ lang: 'en' }, { 'x-lang': 'hi' }), key({ lang: 'en' }));
  assert.equal(key({ lang: 'en', limit: '0' }), key({ lang: 'en', limit: '1' }));
  assert.equal(key({ category: 'national', q: 'a'.repeat(90) }), key({ category: 'national', q: 'a'.repeat(80) }));
});

test('keys exclude ignored options but separate active latest fallback aliases', (t) => {
  const key = capturePublicNewsCacheKey(t);
  const category = { category: 'pulse-dialogue', lang: 'en' };
  assert.equal(key(category), key({ ...category, strictLocale: '1', search: 'ignored', spotlight: '1', fallback: 'true', type: 'article' }));
  assert.equal(key({ lang: 'en' }), key({ lang: 'en', fallback: 'false', founderOnly: 'no' }));
  assert.notEqual(key({ lang: 'en' }), key({ lang: 'en', fallback: 'true' }));
  assert.equal(key({ lang: 'en', fallback: 'yes' }), key({ language: 'English', allowFallback: '1' }));
  assert.equal(key({ lang: 'en', fallback: '0', fallbackToBase: 'y' }), key({ lang: 'en', fallback: '1' }));
});

test('invalid inputs cannot reuse successful cached responses and filtered latest stays uncached', (t) => {
  const key = capturePublicNewsCacheKey(t);
  for (const query of [
    { category: 'national', page: 'bad' }, { category: 'national', limit: 'bad' },
    { category: 'national', page: '1000000000000000000000' },
    { category: 'youth-pulse', track: 'invalid' }, { category: 'youth-pulse', track: '' },
    { page: '2' }, { q: 'news' }, { topic: 'politics' }, { state: 'Gujarat' },
    { track: 'campus-buzz' }, { founderOnly: 'true' }, { type: 'video' },
  ]) assert.equal(key(query), null, JSON.stringify(query));
});

test('variant keys hide free text and avoid unsafe Unicode case-fold collisions', (t) => {
  const key = capturePublicNewsCacheKey(t);
  const value = key({ category: 'national', q: 'person@example.test secret-token', state: 'private-location' }, { authorization: 'Bearer secret-token' });
  assert.match(value, /^np:v1:category:national:gu:page:1:v2:[a-f0-9]{64}$/);
  assert.equal(/person|secret|private|Bearer/.test(value), false);
  assert.notEqual(key({ category: 'national', q: '\u0130' }), key({ category: 'national', q: 'i\u0307' }));
  assert.notEqual(key({ category: 'national', state: '\u0130' }), key({ category: 'national', state: 'i\u0307' }));
});

test('new variants avoid old entries and retain takedown invalidation coverage', async (t) => {
  const key = capturePublicNewsCacheKey(t);
  const cache = require('../lib/cache');
  const oldKey = cache.buildCategoryCacheKey('national', 'en', 1);
  const variants = [key({ category: 'national', lang: 'en', limit: '30' }), key({ category: 'national', lang: 'en', limit: '90' }), key({ lang: 'gu', fallback: 'true' })];
  await cache.safeSetCacheWithStale(oldKey, { status: 200, body: { items: ['old'] } }, 45);
  assert.equal(await cache.safeGetCache(variants[0]), null);
  for (const variant of variants) await cache.safeSetCacheWithStale(variant, { status: 200, body: { items: ['new'] } }, 45);
  await cache.invalidateArticleCaches();
  for (const variant of [oldKey, ...variants]) {
    assert.equal(await cache.safeGetCache(variant), null);
    assert.equal(await cache.safeGetCache(cache.buildStaleCacheKey(variant)), null);
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      return setTimeout(tick, 5);
    };
    tick();
  });
}

function publicNewsCacheOptions(handler, options = {}) {
  return {
    ttlSeconds: options.ttlSeconds || 45,
    staleWhileRevalidate: true,
    backgroundRebuild: handler,
    deterministicTtlSpreadSeconds: 15,
    rebuildConcurrencyGroup: options.rebuildConcurrencyGroup || `public-news-test-${Date.now()}-${Math.random()}`,
    rebuildConcurrencyLimit: options.rebuildConcurrencyLimit || 2,
    lockTtlSeconds: 60,
    coldCacheWaitMs: options.coldCacheWaitMs || 180,
    coldCachePollMs: 15,
    rebuildAdmissionTimeoutMs: options.rebuildAdmissionTimeoutMs || 180,
    rebuildCommandTimeoutMs: options.rebuildCommandTimeoutMs || 180,
    onRebuildUnavailable: (_req, res) => res.set('Retry-After', '1').status(503).json({ items: [], page: 1, limit: 30, total: 0, totalPages: 1 }),
    buildKey: (req) => `np:v1:test:public-news:${req.params.key || 'default'}`,
    shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Array.isArray(body.items),
  };
}

function makePublicNewsCacheApp(cache, handler, options = {}) {
  const app = express();
  const routeHandler = options.routeHandler || handler;
  app.get('/cached/:key?', cache.createJsonCacheMiddleware(publicNewsCacheOptions(handler, options)), routeHandler);
  return app;
}

async function flushPromises() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

function makeLifecycleHarness(t, handler, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  t.after(loaded.restore);
  const middleware = loaded.cache.createJsonCacheMiddleware(publicNewsCacheOptions(handler, {
    rebuildAdmissionTimeoutMs: 100,
    rebuildCommandTimeoutMs: 20,
    coldCacheWaitMs: 40,
    ...options,
  }));
  return {
    redis,
    cache: loaded.cache,
    async advance(milliseconds) {
      redis.advance(milliseconds);
      t.mock.timers.tick(milliseconds);
      await flushPromises();
    },
    request(key) {
      const req = new EventEmitter();
      Object.assign(req, { method: 'GET', params: { key }, query: {}, headers: {} });
      const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, headers: {}, destroyed: false, writableFinished: false });
      res.set = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => {
        assert.equal(res.destroyed, false, 'must not respond to a disconnected client');
        res.body = body;
        res.writableFinished = true;
        res.writableEnded = true;
        res.emit('finish');
        return res;
      };
      const task = { req, res, settled: false };
      task.promise = middleware(req, res, (error) => {
        assert.ok(error, 'bounded requests must not bypass admission into the next controller');
        res.status(500).json({ items: [], message: error.message });
      }).then(() => { task.settled = true; });
      return task;
    },
  };
}

test('foreground and background rebuild clones retain the initiating request identity', async (t) => {
  const { getRequestTimingState } = require('../lib/timingDiagnostics');
  const captured = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    captured.push(getRequestTimingState(req).requestId);
    res.json({ items: [] });
  });
  const foreground = harness.request('foreground');
  await foreground.promise;
  assert.equal(captured[0], getRequestTimingState(foreground.req).requestId);
  await harness.cache.safeSetCache('np:v1:test:public-news:background:stale', { status: 200, body: { items: [] } }, 45);
  const background = harness.request('background');
  await background.promise;
  await flushPromises();
  assert.equal(captured[1], getRequestTimingState(background.req).requestId);
  assert.notEqual(captured[0], captured[1]);
  assert.deepEqual(foreground.res.body, { items: [] });
  assert.deepEqual(background.res.body, { items: [] });
  const cached = await harness.cache.safeGetCache('np:v1:test:public-news:foreground');
  assert.equal(JSON.stringify(cached).includes(captured[0]), false);
  const cacheHit = harness.request('foreground');
  await cacheHit.promise;
  assert.deepEqual(cacheHit.res.body, { items: [] });
  assert.notEqual(getRequestTimingState(cacheHit.req).requestId, captured[0]);
  assert.equal(captured.length, 2);
});

test('cross-key backlog has a finite admission deadline and holds no queued locks', async (t) => {
  const release = deferred();
  const started = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  const queued = ['national', 'regional', 'glamour', 'sports'].map((key) => harness.request(key));
  await flushPromises();
  assert.equal(started.length, 2);
  assert.equal(harness.redis.entries.has('np:v1:test:public-news:national:lock'), false);
  await harness.advance(99);
  assert.ok(queued.every((task) => !task.settled));
  await harness.advance(2);
  assert.ok(queued.every((task) => task.settled && task.res.statusCode === 503));
  assert.equal(started.length, 2);
  release.resolve();
  await Promise.all([first.promise, second.promise]);
  const next = harness.request('next');
  await next.promise;
  assert.equal(next.res.statusCode, 200);
});

for (const event of ['close', 'aborted']) {
  test(`queued client ${event} removes work before admission`, async (t) => {
    const release = deferred();
    const started = [];
    const harness = makeLifecycleHarness(t, async (req, res) => {
      started.push(req.params.key);
      await release.promise;
      res.json({ items: [] });
    });
    const first = harness.request('one');
    const second = harness.request('two');
    await flushPromises();
    const dead = harness.request('dead');
    await flushPromises();
    assert.equal(dead.res.listenerCount('close'), 1);
    if (event === 'close') { dead.res.destroyed = true; dead.res.emit('close'); }
    else { dead.req.aborted = true; dead.req.emit('aborted'); }
    await dead.promise;
    assert.equal(dead.req.listenerCount('aborted'), 0);
    assert.equal(dead.res.listenerCount('close'), 0);
    release.resolve();
    await Promise.all([first.promise, second.promise]);
    const next = harness.request('next');
    await next.promise;
    assert.equal(started.includes('dead'), false);
    assert.equal(harness.redis.entries.has('np:v1:test:public-news:dead'), false);
    assert.equal(next.res.statusCode, 200);
  });
}

test('expired admission is rejected even before its delayed timer callback executes', async (t) => {
  const release = deferred();
  const started = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  const expired = harness.request('expired');
  await flushPromises();
  t.mock.timers.setTime(Date.now() + 101);
  release.resolve();
  await Promise.all([first.promise, second.promise, expired.promise]);
  assert.equal(expired.res.statusCode, 503);
  assert.equal(started.includes('expired'), false);
});

test('cache created while queued is returned after admission even after an earlier lock expires', async (t) => {
  const release = deferred();
  const started = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  }, { rebuildAdmissionTimeoutMs: 2000 });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  const key = 'np:v1:test:public-news:queued';
  await harness.cache.safeAcquireRebuildLock(key, 1);
  const queued = harness.request('queued');
  await flushPromises();
  await harness.advance(1001);
  assert.equal(await harness.redis.get(`${key}:lock`), null);
  await harness.cache.safeSetCache(key, { status: 200, body: { items: [{ source: 'other-owner' }] } }, 45);
  release.resolve();
  await Promise.all([first.promise, second.promise, queued.promise]);
  assert.equal(started.includes('queued'), false);
  assert.equal(queued.res.body.items[0].source, 'other-owner');
  assert.equal(await harness.redis.get(`${key}:lock`), null);
});

test('replacement lock acquired during queue wait prevents the queued job rebuilding', async (t) => {
  const release = deferred();
  const started = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  }, { rebuildAdmissionTimeoutMs: 2000 });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  const key = 'np:v1:test:public-news:queued';
  await harness.cache.safeAcquireRebuildLock(key, 1);
  const queued = harness.request('queued');
  await flushPromises();
  await harness.advance(1001);
  const replacement = await harness.cache.safeAcquireRebuildLock(key, 60);
  release.resolve();
  await Promise.all([first.promise, second.promise]);
  await flushPromises();
  for (let tick = 0; tick < 3; tick += 1) await harness.advance(15);
  await queued.promise;
  assert.equal(queued.res.statusCode, 503);
  assert.equal(started.includes('queued'), false);
  assert.equal(await harness.redis.get(`${key}:lock`), replacement.token);
});

test('cold follower uses completed cache without a duplicate controller call', async (t) => {
  const release = deferred();
  let calls = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    calls += 1;
    await release.promise;
    res.json({ items: [{ source: 'owner' }] });
  });
  const owner = harness.request('same');
  await flushPromises();
  const follower = harness.request('same');
  await flushPromises();
  release.resolve();
  await owner.promise;
  await harness.advance(15);
  await follower.promise;
  assert.equal(calls, 1);
  assert.equal(follower.res.body.items[0].source, 'owner');
});

test('stale response does not wait for saturated foreground slots', async (t) => {
  const release = deferred();
  let calls = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    calls += 1;
    await release.promise;
    res.json({ items: [] });
  });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  await harness.cache.safeSetCache('np:v1:test:public-news:stale:stale', { status: 200, body: { items: ['stale'] } }, 45);
  const stale = harness.request('stale');
  await stale.promise;
  assert.deepEqual(stale.res.body.items, ['stale']);
  assert.equal(calls, 2);
  await harness.advance(101);
  release.resolve();
  await Promise.all([first.promise, second.promise]);
  assert.equal(calls, 2);
});

for (const fault of ['write-failure', 'write-stall', 'release-failure', 'release-stall', 'acquire-stall', 'read-stall']) {
  test(`limiter slots release after Redis ${fault}`, async (t) => {
    const harness = makeLifecycleHarness(t, async (_req, res) => res.json({ items: [] }), { rebuildAdmissionTimeoutMs: 500 });
    const originalSet = harness.redis.set.bind(harness.redis);
    const originalGet = harness.redis.get.bind(harness.redis);
    const originalEval = harness.redis.eval.bind(harness.redis);
    const failing = (key) => /:(one|two)(:lock|:stale)?$/.test(key);
    const fail = () => {
      if (fault.endsWith('stall')) return new Promise(() => {});
      throw new Error('simulated Redis failure');
    };
    harness.redis.set = async (key, value, ...args) => {
      if (failing(key) && ((fault.startsWith('write') && !args.includes('NX')) || (fault.startsWith('acquire') && args.includes('NX')))) return fail();
      return originalSet(key, value, ...args);
    };
    harness.redis.get = async (key) => fault === 'read-stall' && failing(key) ? fail() : originalGet(key);
    harness.redis.eval = async (...args) => fault.startsWith('release') && failing(args[2]) ? fail() : originalEval(...args);
    const first = harness.request('one');
    const second = harness.request('two');
    await flushPromises();
    const third = harness.request('three');
    for (let tick = 0; tick < 12; tick += 1) await harness.advance(21);
    assert.equal(first.settled, true);
    assert.equal(second.settled, true);
    assert.equal(third.settled, true);
    assert.equal(third.res.statusCode, 200);
    if (fault.startsWith('write')) {
      assert.equal(harness.redis.entries.has('np:v1:test:public-news:one:stale'), false);
    }
  });
}

test('controller exceptions release slots and reach the error response', async (t) => {
  const harness = makeLifecycleHarness(t, async (req, res) => {
    if (req.params.key !== 'success') throw new Error('simulated controller failure');
    res.json({ items: [] });
  });
  const tasks = ['one', 'two', 'success'].map((key) => harness.request(key));
  await Promise.all(tasks.map((task) => task.promise));
  assert.deepEqual(tasks.map((task) => task.res.statusCode), [500, 500, 200]);
  assert.equal(await harness.redis.get('np:v1:test:public-news:one:lock'), null);
});

test('active disconnect releases the slot and late controller completion never writes cache', async (t) => {
  const release = deferred();
  const harness = makeLifecycleHarness(t, async (req, res) => {
    if (req.params.key === 'dead') await release.promise;
    res.json({ items: [] });
  });
  const dead = harness.request('dead');
  await flushPromises();
  dead.res.destroyed = true;
  dead.res.emit('close');
  await dead.promise;
  const next = harness.request('next');
  await next.promise;
  release.resolve();
  await flushPromises();
  assert.equal(harness.redis.entries.has('np:v1:test:public-news:dead'), false);
  assert.equal(await harness.redis.get('np:v1:test:public-news:dead:lock'), null);
  assert.equal(next.res.statusCode, 200);
});

test('rebuild exceeding the lock lifetime releases slots and ignores late results', async (t) => {
  const release = deferred();
  const harness = makeLifecycleHarness(t, async (req, res) => {
    if (req.params.key !== 'next') await release.promise;
    res.json({ items: [] });
  });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  await harness.advance(60001);
  await Promise.all([first.promise, second.promise]);
  assert.equal(first.res.statusCode, 503);
  assert.equal(second.res.statusCode, 503);
  const next = harness.request('next');
  await next.promise;
  release.resolve();
  await flushPromises();
  assert.equal(harness.redis.entries.has('np:v1:test:public-news:one'), false);
  assert.equal(next.res.statusCode, 200);
});

test('public-news foreground admission expires without running another category rebuild', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  t.after(loaded.restore);
  const release = deferred();
  const started = [];
  const app = makePublicNewsCacheApp(loaded.cache, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  }, { rebuildAdmissionTimeoutMs: 30 });
  const first = request(app).get('/cached/one').then((response) => response);
  const second = request(app).get('/cached/two').then((response) => response);
  await waitFor(() => started.length === 2);
  let deadline;
  const third = request(app).get('/cached/three').then((response) => response);
  try {
    const result = await Promise.race([
      third,
      new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 300); }),
    ]);
    assert.equal(result?.status, 503);
    assert.equal(result.headers['retry-after'], '1');
    assert.deepEqual(started.slice().sort(), ['one', 'two']);
  } finally {
    clearTimeout(deadline);
    release.resolve();
    await Promise.all([first, second, third]);
  }
});

test('cache middleware protects rebuilds, serves stale data, and fails open', async (t) => {
  const redis = new FakeRedis();
  const state = { ready: true };
  const loaded = loadCache(redis, state);
  const { cache } = loaded;
  t.after(loaded.restore);

  await cache.safeSetCache('np:v1:test:cache', { status: 200, body: { source: 'fresh' } }, 20);
  let runs = 0;
  const hitApp = makeApp(cache, (_req, res) => res.json({ source: 'controller' }));
  const hit = await request(hitApp).get('/cached').expect(200);
  assert.equal(hit.body.source, 'fresh');

  await redis.del(['np:v1:test:cache']);
  const missApp = makeApp(cache, async (_req, res) => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 45));
    res.json({ source: 'rebuilt' });
  });
  const [first, second] = await Promise.all([request(missApp).get('/cached'), request(missApp).get('/cached')]);
  assert.equal(runs, 1);
  assert.equal(first.body.source, 'rebuilt');
  assert.equal(second.body.source, 'rebuilt');
  assert.deepEqual(JSON.parse(await redis.get('np:v1:test:cache:stale')).body, { source: 'rebuilt' });

  await redis.del(['np:v1:test:cache']);
  await cache.safeSetCache('np:v1:test:cache:stale', { status: 200, body: { source: 'stale' } }, 20);
  await redis.set('np:v1:test:cache:lock', 'another-owner', 'EX', 15, 'NX');
  const stale = await request(makeApp(cache, (_req, res) => res.json({ source: 'controller' }))).get('/cached').expect(200);
  assert.equal(stale.body.source, 'stale');

  await redis.del(['np:v1:test:cache', 'np:v1:test:cache:stale', 'np:v1:test:cache:lock']);
  await redis.set('np:v1:test:cache:lock', 'another-owner', 'EX', 15, 'NX');
  setTimeout(() => cache.safeSetCache('np:v1:test:cache', { status: 200, body: { source: 'waited' } }, 20), 35);
  const waited = await request(makeApp(cache, (_req, res) => res.json({ source: 'controller' }))).get('/cached').expect(200);
  assert.equal(waited.body.source, 'waited');

  await redis.del(['np:v1:test:cache', 'np:v1:test:cache:lock']);
  state.ready = false;
  let failOpenRuns = 0;
  const failOpen = await request(makeApp(cache, (_req, res) => {
    failOpenRuns += 1;
    res.json({ source: 'uncached' });
  })).get('/cached').expect(200);
  assert.equal(failOpenRuns, 1);
  assert.equal(failOpen.body.source, 'uncached');
});

test('locks are owner-safe, expire, and cache TTLs use bounded jitter', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  const lock = await cache.safeAcquireRebuildLock('np:v1:test:lock', 2);
  assert.ok(lock);
  await redis.set(lock.lockKey, 'new-owner', 'EX', 2);
  assert.equal(await cache.safeReleaseRebuildLock(lock), 0);
  assert.equal(await redis.get(lock.lockKey), 'new-owner');
  redis.advance(2001);
  const replacementLock = await cache.safeAcquireRebuildLock('np:v1:test:lock', 2);
  assert.ok(replacementLock);
  assert.equal(await cache.safeReleaseRebuildLock(replacementLock), 1);
  assert.equal(await redis.get(replacementLock.lockKey), null);
  assert.equal(cache.getJitteredTtlSeconds(100, () => 0), 100);
  assert.equal(cache.getJitteredTtlSeconds(100, () => 1), 110);
  assert.equal(cache.getStaleTtlSeconds(110, 100), 210);
});

test('public-news cache serves stale immediately and refreshes in background', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  const key = 'np:v1:test:public-news:default';
  await cache.safeSetCache(cache.buildStaleCacheKey(key), { status: 200, body: { items: [{ source: 'stale' }] } }, 120);
  const releaseRefresh = deferred();
  let refreshRuns = 0;
  const app = makePublicNewsCacheApp(cache, async (_req, res) => {
    refreshRuns += 1;
    await releaseRefresh.promise;
    return res.status(200).json({ items: [{ source: 'fresh' }] });
  });

  const stale = await request(app).get('/cached').expect(200);
  assert.deepEqual(stale.body, { items: [{ source: 'stale' }] });
  await waitFor(() => refreshRuns === 1);
  assert.equal(await redis.get(key), null);

  releaseRefresh.resolve();
  await waitFor(async () => Boolean(await redis.get(key)));
  assert.deepEqual(JSON.parse(await redis.get(key)).body, { items: [{ source: 'fresh' }] });
});

test('public-news cache still rebuilds the same stale key only once', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  const key = 'np:v1:test:public-news:default';
  await cache.safeSetCache(cache.buildStaleCacheKey(key), { status: 200, body: { items: [{ source: 'stale' }] } }, 120);
  const releaseRefresh = deferred();
  let refreshRuns = 0;
  const app = makePublicNewsCacheApp(cache, async (_req, res) => {
    refreshRuns += 1;
    await releaseRefresh.promise;
    return res.status(200).json({ items: [{ source: 'fresh' }] });
  });

  const responses = await Promise.all([
    request(app).get('/cached'),
    request(app).get('/cached'),
    request(app).get('/cached'),
  ]);
  assert.deepEqual(responses.map((res) => res.body.items[0].source), ['stale', 'stale', 'stale']);
  await waitFor(() => refreshRuns === 1);
  releaseRefresh.resolve();
});

test('public-news cache limits concurrent rebuilds across different keys', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  for (const suffix of ['one', 'two', 'three']) {
    const key = `np:v1:test:public-news:${suffix}`;
    await cache.safeSetCache(cache.buildStaleCacheKey(key), { status: 200, body: { items: [{ source: `stale-${suffix}` }] } }, 120);
  }

  const releaseRefresh = deferred();
  let active = 0;
  let maxActive = 0;
  const started = [];
  const app = makePublicNewsCacheApp(cache, async (req, res) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(req.params.key);
    await releaseRefresh.promise;
    active -= 1;
    return res.status(200).json({ items: [{ source: `fresh-${req.params.key}` }] });
  }, { rebuildConcurrencyGroup: 'public-news-concurrency-test', rebuildConcurrencyLimit: 2 });

  const responses = await Promise.all([
    request(app).get('/cached/one'),
    request(app).get('/cached/two'),
    request(app).get('/cached/three'),
  ]);
  assert.deepEqual(responses.map((res) => res.body.items[0].source).sort(), ['stale-one', 'stale-three', 'stale-two']);
  await waitFor(() => started.length === 2);
  assert.equal(maxActive, 2);
  assert.equal(started.includes('three') && started.includes('one') && started.includes('two'), false);
  releaseRefresh.resolve();
  await waitFor(() => started.length === 3);
  assert.equal(maxActive, 2);
});

test('public-news cache uses deterministic 45 to 60 second TTL spread', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  const latestKey = cache.buildLatestCacheKey('gu');
  const nationalKey = cache.buildCategoryCacheKey('national', 'gu', 1);
  const latestTtl = cache.getDeterministicSpreadTtlSeconds(45, latestKey, 15);
  const latestTtlAgain = cache.getDeterministicSpreadTtlSeconds(45, latestKey, 15);
  const nationalTtl = cache.getDeterministicSpreadTtlSeconds(45, nationalKey, 15);

  assert.equal(latestTtl, latestTtlAgain);
  assert.ok(latestTtl >= 45 && latestTtl <= 60);
  assert.ok(nationalTtl >= 45 && nationalTtl <= 60);

  await cache.safeSetCacheWithStale(latestKey, { status: 200, body: { items: [] } }, 45, { deterministicTtlSpreadSeconds: 15 });
  assert.equal(redis.entries.get(latestKey).expiresAt - redis.now, latestTtl * 1000);
});

test('public-news cold cache miss waits for rebuild and preserves API body', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  let handlerRuns = 0;
  const app = makePublicNewsCacheApp(cache, async (_req, res) => {
    handlerRuns += 1;
    return res.status(200).json({ items: [{ source: 'controller' }], page: 1, limit: 30, total: 1, totalPages: 1 });
  });

  const response = await request(app).get('/cached').expect(200);
  assert.equal(handlerRuns, 1);
  assert.deepEqual(response.body, { items: [{ source: 'controller' }], page: 1, limit: 30, total: 1, totalPages: 1 });
  assert.deepEqual(JSON.parse(await redis.get('np:v1:test:public-news:default')).body, response.body);
});

test('stale companions invalidate with all public cache families and key dimensions remain isolated', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const { cache } = loaded;
  t.after(loaded.restore);

  const keys = [
    cache.buildArticleCacheKey('en', 'story'), cache.buildArticleCacheKey('hi', 'story'), cache.buildArticleCacheKey('gu', 'story'),
    cache.buildAdsCacheKey('HOME_728x90'), cache.buildBroadcastCacheKey('hi'), cache.buildPublicSettingsCacheKey(),
  ];
  for (const key of keys) await cache.safeSetCacheWithStale(key, { status: 200, body: { key } }, 10, { random: () => 0 });
  await cache.invalidateArticleCaches();
  await cache.invalidateAdsCaches('HOME_728x90');
  await cache.invalidateBroadcastCaches();
  await cache.invalidatePublicSettingsCaches();
  for (const key of keys) {
    assert.equal(await redis.get(key), null);
    assert.equal(await redis.get(cache.buildStaleCacheKey(key)), null);
  }
  assert.notEqual(cache.buildHomeCacheKey('en'), cache.buildHomeCacheKey('hi'));
  assert.notEqual(cache.buildHomeCacheKey('hi'), cache.buildHomeCacheKey('gu'));
  assert.notEqual(cache.buildCategoryCacheKey('sports', 'en', 1), cache.buildCategoryCacheKey('sports', 'en', 2));
  assert.notEqual(cache.buildCategoryCacheKey('sports', 'en', 1), cache.buildCategoryCacheKey('sports', 'hi', 1));
});

test('/for-you does not share a cached response for authenticated requests', async (t) => {
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  const feedPath = require.resolve('../routes/feed');
  const News = require('../models/News');
  const originalFind = News.find;
  delete require.cache[feedPath];
  const feed = require('../routes/feed');
  t.after(() => {
    News.find = originalFind;
    delete require.cache[feedPath];
    loaded.restore();
  });

  let findCalls = 0;
  News.find = () => ({
    sort: () => ({
      limit: () => ({
        lean: async () => {
          findCalls += 1;
          return [{ _id: `story-${findCalls}`, title: `story-${findCalls}` }];
        },
      }),
    }),
  });
  const app = express();
  app.use('/api/feed', feed);
  const first = await request(app).get('/api/feed/for-you').set('Authorization', 'Bearer first-user').expect(200);
  const second = await request(app).get('/api/feed/for-you').set('Authorization', 'Bearer second-user').expect(200);
  assert.equal(findCalls, 2);
  assert.equal(first.body.items[0]._id, 'story-1');
  assert.equal(second.body.items[0]._id, 'story-2');
});