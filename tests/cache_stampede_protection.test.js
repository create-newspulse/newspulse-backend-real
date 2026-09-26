const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const express = require('express');
const request = require('supertest');
const { getRequestTimingState, setRequestTimingCacheContext } = require('../lib/timingDiagnostics');

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

  async eval(_script, keyCount, key, ...args) {
    if (keyCount === 2) {
      const [targetKey, token, value, ttl] = args;
      if ((await this.get(key)) !== token) return 0;
      return this.set(targetKey, value, 'EX', ttl);
    }
    const [token] = args;
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
  let buildLastKnownGoodKey;
  let router;
  loaded.cache.createJsonCacheMiddleware = (options) => {
    assert.equal(options.publicNewsDiagnostics, true);
    buildKey = options.buildKey;
    buildLastKnownGoodKey = options.buildLastKnownGoodKey;
    return originalFactory(options);
  };
  try {
    delete require.cache[routePath];
    router = require(routePath);
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
  const key = (query, headers = {}, requestState = {}) => buildKey({ ...requestState, query, headers });
  key.lastKnownGood = (query) => buildLastKnownGoodKey({ query, headers: {} }, key(query));
  key.router = router;
  return key;
}

test('canonical latest keys are stable, language-isolated and alone eligible for LKG', (t) => {
  const key = capturePublicNewsCacheKey(t);
  const variant = 'ee2450384fc7c547774c0e16dd90fbb20b1648e155856157ebd274df26231b08';
  for (const lang of ['en', 'hi', 'gu']) {
    const query = { lang, language: lang, limit: '40' };
    const expected = `np:v1:latest:${lang}:v2:${variant}`;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      assert.equal(key(query, { 'x-request-id': String(iteration), 'x-lang': 'en', authorization: 'ignored' }), expected);
      assert.equal(key({ limit: '40', language: lang, lang, page: '1', timestamp: String(iteration) }), expected);
      assert.equal(key(query, {}, { aborted: iteration % 2 === 0, requestId: String(iteration), timestamp: Date.now() }), expected);
    }
    assert.equal(key.lastKnownGood(query), `np:v1:latest-lkg:${lang}:v2:${variant}`);
    for (const extra of [{ limit: '30' }, { fallback: 'true' }, { page: '2' }, { category: 'national' }, { q: 'test' }, { track: 'campus-buzz' }]) {
      assert.equal(key.lastKnownGood({ ...query, ...extra }), null);
    }
  }
});

test('canonical GETs and unrelated invalidation preserve latest tiers; article invalidation preserves all LKGs', async (t) => {
  const key = capturePublicNewsCacheKey(t);
  const cache = require('../lib/cache');
  const app = express();
  app.use('/api/public/news', key.router);
  let invalidations = 0;
  t.after(cache.onArticleCachesInvalidated(() => { invalidations += 1; }));
  const feeds = ['en', 'hi', 'gu'].map((language) => {
    const query = { lang: language, language, limit: '40' };
    return { query, freshKey: key(query), lastKey: key.lastKnownGood(query), body: {
      items: [{ language }], page: 1, limit: 40, total: 1, totalPages: 1,
    } };
  });
  for (const feed of feeds) {
    const payload = { status: 200, body: feed.body };
    await cache.safeSetCacheWithStale(feed.freshKey, payload, 45);
    await cache.safeSetCache(feed.lastKey, payload, 86400);
    for (let count = 0; count < 3; count += 1) {
      const response = await request(app).get('/api/public/news').query(feed.query).expect(200);
      assert.deepEqual(response.body, feed.body);
    }
  }
  await cache.invalidateBroadcastCaches();
  await cache.invalidatePublicSettingsCaches();
  await cache.invalidateAdsCaches();
  await cache.invalidateArticleLanguageCaches('detail-only');
  assert.equal(invalidations, 0);
  for (const feed of feeds) {
    assert.deepEqual((await cache.safeGetCache(feed.freshKey)).body, feed.body);
    assert.deepEqual((await cache.safeGetCache(cache.buildStaleCacheKey(feed.freshKey))).body, feed.body);
    assert.deepEqual((await cache.safeGetCache(feed.lastKey)).body, feed.body);
  }
  await cache.invalidateArticleCaches();
  assert.equal(invalidations, 1);
  for (const feed of feeds) {
    assert.equal(await cache.safeGetCache(feed.freshKey), null);
    assert.equal(await cache.safeGetCache(cache.buildStaleCacheKey(feed.freshKey)), null);
    assert.deepEqual((await cache.safeGetCache(feed.lastKey)).body, feed.body);
  }
});

test('withdrawal invalidation removes canonical LKG in every language and schedules warming without awaiting it', async (t) => {
  const key = capturePublicNewsCacheKey(t);
  const cache = require('../lib/cache');
  const keys = ['en', 'hi', 'gu'].map((language) => {
    const query = { lang: language, language, limit: '40' };
    return { fresh: key(query), last: key.lastKnownGood(query), language };
  });
  for (const entry of keys) {
    const payload = { status: 200, body: { items: [{ id: 'withdrawn', language: entry.language }] } };
    await cache.safeSetCacheWithStale(entry.fresh, payload, 45);
    await cache.safeSetCache(entry.last, payload, 86400);
  }
  let scheduled = false;
  t.after(cache.onArticleCachesInvalidated(() => {
    scheduled = true;
    return new Promise(() => {});
  }));
  await cache.invalidateArticleCaches({ publicVisibilityRemoved: true });
  assert.equal(scheduled, true);
  for (const entry of keys) {
    assert.equal(await cache.safeGetCache(entry.fresh), null);
    assert.equal(await cache.safeGetCache(cache.buildStaleCacheKey(entry.fresh)), null);
    assert.equal(await cache.safeGetCache(entry.last), null);
  }
});

test('startup and mutation prewarm wait for readiness, stagger languages, and never block invalidation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const redis = new FakeRedis();
  const loaded = loadCache(redis);
  t.after(loaded.restore);
  const modulePath = require.resolve('../lib/publicNewsPrewarm');
  delete require.cache[modulePath];
  const { startCanonicalLatestPrewarm } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const mongo = Object.assign(new EventEmitter(), { readyState: 0 });
  const redisEvents = new EventEmitter();
  let redisReady = false;
  const started = [];
  let release = deferred();
  const stop = startCanonicalLatestPrewarm({
    mongo, redis: redisEvents, redisReady: () => redisReady,
    refresh: async (req) => {
      started.push(req.query.lang);
      assert.deepEqual(req.query, { lang: req.query.lang, language: req.query.lang, limit: '40' });
      assert.equal(req.signal, undefined);
      if (req.query.lang === 'hi') throw new Error('simulated failure');
      await release.promise;
      return true;
    },
  });
  t.after(stop);
  assert.deepEqual(started, []);
  mongo.readyState = 1;
  mongo.emit('connected');
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.deepEqual(started, []);
  redisReady = true;
  redisEvents.emit('ready');
  t.mock.timers.tick(999);
  await flushPromises();
  assert.deepEqual(started, []);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.deepEqual(started, ['en']);
  t.mock.timers.tick(10000);
  await flushPromises();
  assert.deepEqual(started, ['en']);
  release.resolve();
  await flushPromises();
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.deepEqual(started, ['en', 'hi']);
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.deepEqual(started, ['en', 'hi', 'gu']);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    t.mock.timers.tick(1000);
    await flushPromises();
  }
  assert.equal(started.filter((lang) => lang === 'hi').length, 3);
  const count = started.length;
  release = deferred();
  await loaded.cache.safeSetCache('np:v1:latest:hi:test', { status: 200, body: { items: [] } }, 45);
  await loaded.cache.safeSetCache('np:v1:latest-lkg:hi:test', { status: 200, body: { items: [] } }, 86400);
  await loaded.cache.invalidateArticleCaches();
  await loaded.cache.invalidateArticleCaches();
  assert.equal(started.length, count);
  assert.equal(await loaded.cache.safeGetCache('np:v1:latest:hi:test'), null);
  assert.ok(await loaded.cache.safeGetCache('np:v1:latest-lkg:hi:test'));
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.equal(started.length, count + 1);
  stop();
  release.resolve();
  await flushPromises();
});

test('withdrawal prewarm starts asynchronously without the startup delay and failures stay serial', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const loaded = loadCache(new FakeRedis());
  t.after(loaded.restore);
  const modulePath = require.resolve('../lib/publicNewsPrewarm');
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const started = [];
  const release = deferred();
  const stop = require(modulePath).startCanonicalLatestPrewarm({
    mongo: Object.assign(new EventEmitter(), { readyState: 1 }),
    redis: new EventEmitter(),
    refresh: async (req) => {
      started.push(req.query.lang);
      await release.promise;
      throw new Error('warm failed');
    },
  });
  t.after(stop);
  await loaded.cache.invalidateArticleCaches({ publicVisibilityRemoved: true });
  assert.deepEqual(started, []);
  t.mock.timers.tick(0);
  await flushPromises();
  assert.deepEqual(started, ['en']);
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.deepEqual(started, ['en']);
  release.resolve();
  await flushPromises();
  t.mock.timers.tick(999);
  await flushPromises();
  assert.deepEqual(started, ['en']);
  t.mock.timers.tick(1);
  await flushPromises();
  assert.deepEqual(started, ['en', 'hi']);
});

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
    publicNewsDiagnostics: options.publicNewsDiagnostics === true,
    buildLastKnownGoodKey: options.buildLastKnownGoodKey,
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
    buildKey: options.buildKey || ((req) => {
      const key = `np:v1:test:public-news:${req.params.key || 'default'}`;
      if (options.publicNewsDiagnostics) setRequestTimingCacheContext(req, { cacheFamily: 'latest', cacheKey: key });
      return key;
    }),
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
  const loaded = loadCache(redis, options.redisState);
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
    refresh: (key) => middleware.refresh({ method: 'GET', params: { key }, query: {}, headers: {} }),
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

function captureCacheDiagnostics(t) {
  const entries = [];
  t.mock.method(console, 'log', (tag, payload) => {
    if (tag === '[cache][public-news]') entries.push(payload);
  });
  return entries;
}

for (const language of ['en', 'hi', 'gu']) {
  test(`canonical ${language} rebuild stores fresh/stale/LKG and expiry serves LKG before refresh`, async (t) => {
    const release = deferred();
    let calls = 0;
    const body = { items: [{ language }], page: 1, limit: 40, total: 1, totalPages: 1 };
    const harness = makeLifecycleHarness(t, async (_req, res) => {
      calls += 1;
      if (calls > 1) await release.promise;
      res.json(body);
    }, { buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:') });
    const first = harness.request(language);
    await first.promise;
    const key = `np:v1:test:public-news:${language}`;
    const lastKey = `np:v1:latest-lkg:${language}`;
    assert.ok(harness.redis.entries.has(key));
    assert.ok(harness.redis.entries.has(key + ':stale'));
    assert.equal(harness.redis.entries.get(lastKey).expiresAt, 86400000);
    const fresh = harness.request(language);
    await fresh.promise;
    assert.equal(calls, 1);
    assert.deepEqual(fresh.res.body, body);
    await harness.advance(106000);
    const cached = harness.request(language);
    await cached.promise;
    assert.equal(cached.res.statusCode, 200);
    assert.deepEqual(cached.res.body, body);
    cached.res.emit('close');
    cached.req.emit('aborted');
    await flushPromises();
    assert.equal(calls, 2);
    release.resolve();
    await flushPromises();
    assert.ok(harness.redis.entries.has(key));
    assert.equal(harness.redis.entries.get(lastKey).expiresAt, 86506000);
  });
}

for (const tier of ['stale', 'lkg']) {
  test(`20 identical ${tier} requests respond immediately with only one detached rebuild`, async (t) => {
    const release = deferred();
    let calls = 0;
    const harness = makeLifecycleHarness(t, async (req, res) => {
      calls += 1;
      assert.equal(req.signal, undefined);
      assert.equal(req.aborted, undefined);
      await release.promise;
      res.json({ items: [{ language: 'hi', refreshed: true }] });
    }, { buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:') });
    const key = 'np:v1:test:public-news:hi';
    const lastKey = 'np:v1:latest-lkg:hi';
    const body = { items: [{ language: 'hi' }], page: 1, limit: 40, total: 1, totalPages: 1 };
    await harness.cache.safeSetCache(tier === 'stale' ? key + ':stale' : lastKey, { status: 200, body }, 86400);
    const tasks = Array.from({ length: 20 }, () => harness.request('hi'));
    const browser = new AbortController();
    for (const task of tasks) task.req.signal = browser.signal;
    await Promise.all(tasks.map((task) => task.promise));
    await flushPromises();
    assert.equal(calls, 1);
    for (const task of tasks) {
      assert.equal(task.res.statusCode, 200);
      assert.deepEqual(task.res.body, body);
      task.res.destroyed = true;
      task.res.emit('close');
      task.req.aborted = true;
      task.req.emit('aborted');
    }
    browser.abort();
    release.resolve();
    await flushPromises();
    assert.deepEqual((await harness.cache.safeGetCache(lastKey)).body, { items: [{ language: 'hi', refreshed: true }] });
    assert.equal(await harness.cache.safeGetCache('np:v1:latest-lkg:en'), null);
    assert.equal(await harness.cache.safeGetCache('np:v1:latest-lkg:gu'), null);
  });
}

for (const failure of ['exception', '503', 'invalid-items']) {
  test(`failed canonical background refresh (${failure}) preserves LKG and the served response`, async (t) => {
    const harness = makeLifecycleHarness(t, async (_req, res) => {
      if (failure === 'exception') throw new Error('simulated failure');
      if (failure === '503') return res.status(503).json({ items: [] });
      return res.json({ items: null });
    }, { publicNewsDiagnostics: true, buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:') });
    const key = 'np:v1:latest-lkg:gu';
    const payload = { status: 200, body: { items: [{ language: 'gu' }] } };
    await harness.cache.safeSetCache(key, payload, 86400);
    const before = { ...harness.redis.entries.get(key) };
    const task = harness.request('gu');
    await task.promise;
    await flushPromises();
    assert.equal(task.res.statusCode, 200);
    assert.deepEqual(task.res.body, payload.body);
    assert.deepEqual(harness.redis.entries.get(key), before);
    assert.equal(await harness.cache.safeGetCache('np:v1:test:public-news:gu'), null);
  });
}

test('LKG is language-isolated, invalid entries are ignored, and only zero-cache overload gets 503', async (t) => {
  const release = deferred();
  const harness = makeLifecycleHarness(t, async (_req, res) => { await release.promise; res.json({ items: [] }); }, {
    buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:'),
  });
  const en = harness.request('en');
  const gu = harness.request('gu');
  await flushPromises();
  const hi = harness.request('hi');
  await flushPromises();
  await harness.advance(101);
  await hi.promise;
  assert.equal(hi.res.statusCode, 503);
  assert.equal(hi.res.headers['retry-after'], '1');
  assert.deepEqual(hi.res.body, { items: [], page: 1, limit: 30, total: 0, totalPages: 1 });
  for (const lang of ['en', 'hi', 'gu']) {
    await harness.cache.safeSetCache(`np:v1:latest-lkg:${lang}`, { status: 200, body: { items: [{ language: lang }] } }, 86400);
    const cached = harness.request(lang);
    await cached.promise;
    assert.equal(cached.res.statusCode, 200);
    assert.deepEqual(cached.res.body, { items: [{ language: lang }] });
  }
  for (const bad of [{ status: 503, body: { items: [] } }, { status: 200, body: { items: null } }]) {
    await harness.cache.safeSetCache('np:v1:latest-lkg:hi', bad, 86400);
    const invalid = harness.request('hi');
    await flushPromises();
    await harness.advance(101);
    await invalid.promise;
    assert.equal(invalid.res.statusCode, 503);
  }
  release.resolve();
  await Promise.all([en.promise, gu.promise]);
  await flushPromises();
});

for (const tier of ['fresh', 'stale']) {
  test(`canonical invalid ${tier} payload falls through to valid same-language LKG`, async (t) => {
    const release = deferred();
    const harness = makeLifecycleHarness(t, async (_req, res) => {
      await release.promise;
      res.json({ items: [{ language: 'hi' }] });
    }, { buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:') });
    t.after(() => release.resolve());
    const body = { items: [{ language: 'hi' }], page: 1, limit: 40, total: 1, totalPages: 1 };
    await harness.cache.safeSetCache('np:v1:latest-lkg:hi', { status: 200, body }, 86400);
    for (const payload of [{ status: 503, body: { items: [] } }, { status: 200, body: { items: null } }]) {
      await harness.cache.safeSetCache('np:v1:test:public-news:hi' + (tier === 'stale' ? ':stale' : ''), payload, 45);
      const cached = harness.request('hi');
      await cached.promise;
      assert.equal(cached.res.statusCode, 200);
      assert.deepEqual(cached.res.body, body);
    }
    release.resolve();
    await flushPromises();
  });
}

test('low-priority prewarm yields to active requests and shares per-key refresh deduplication', async (t) => {
  const release = deferred();
  const started = [];
  const harness = makeLifecycleHarness(t, async (req, res) => {
    started.push(req.params.key);
    await release.promise;
    res.json({ items: [] });
  }, { buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:') });
  const foreground = harness.request('hi');
  await flushPromises();
  assert.equal(await harness.refresh('en'), false);
  assert.deepEqual(started, ['hi']);
  release.resolve();
  await foreground.promise;
  const warming = harness.refresh('en');
  const duplicate = harness.refresh('en');
  await Promise.all([warming, duplicate]);
  assert.deepEqual(started, ['hi', 'en']);
});

test('withdrawal between ownership check and cache write cannot resurrect LKG, even when subsequent prewarm fails', async (t) => {
  let attempts = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    attempts += 1;
    if (attempts > 1) return res.status(503).json({ items: [] });
    return res.json({ items: [{ id: 'withdrawn', language: 'hi' }] });
  }, {
    buildKey: (req) => `np:v1:latest:${req.params.key}:v2:test`,
    buildLastKnownGoodKey: (_req, key) => key.replace(':latest:', ':latest-lkg:'),
  });
  const key = 'np:v1:latest:hi:v2:test';
  const lastKey = 'np:v1:latest-lkg:hi:v2:test';
  await harness.cache.safeSetCache(lastKey, { status: 200, body: { items: [{ id: 'withdrawn', language: 'hi' }] } }, 86400);
  const originalGet = harness.redis.get.bind(harness.redis);
  let invalidated = false;
  harness.redis.get = async (requestedKey) => {
    const value = await originalGet(requestedKey);
    if (requestedKey === key + ':lock' && value && !invalidated) {
      invalidated = true;
      await harness.cache.invalidateArticleCaches({ publicVisibilityRemoved: true });
    }
    return value;
  };
  assert.equal(await harness.refresh('hi'), false);
  assert.equal(invalidated, true);
  assert.equal(await harness.refresh('hi'), false);
  const visitor = harness.request('hi');
  await visitor.promise;
  assert.equal(visitor.res.statusCode, 503);
  assert.deepEqual(visitor.res.body, { items: [] });
  for (const cacheKey of [key, key + ':stale', lastKey]) {
    assert.equal(await harness.cache.safeGetCache(cacheKey), null);
  }
});

test('canonical rebuild can store LKG after fresh write failure and reports partial storage', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const harness = makeLifecycleHarness(t, async (_req, res) => res.json({ items: [{ language: 'hi' }] }), {
    publicNewsDiagnostics: true, buildLastKnownGoodKey: (_req, key) => key.replace(':test:public-news:', ':latest-lkg:'),
  });
  const originalSet = harness.redis.set.bind(harness.redis);
  harness.redis.set = (key, ...args) => {
    if (key === 'np:v1:test:public-news:hi') throw new Error('write failed');
    return originalSet(key, ...args);
  };
  assert.equal(await harness.refresh('hi'), true);
  assert.ok(await harness.cache.safeGetCache('np:v1:latest-lkg:hi'));
  assert.ok(entries.some((entry) => entry.event === 'storage' && entry.reason === 'lkg_only'));
  assert.equal(entries.some((entry) => entry.event === 'no_store'), false);
});

test('public-news diagnostics correlate lookup and fresh/stale writes without changing JSON or cache hits', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const body = { items: [{ title: 'private-article' }], page: 1, limit: 40, total: 1, totalPages: 1 };
  let calls = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    calls += 1;
    res.json(body);
  }, { publicNewsDiagnostics: true });
  const owner = harness.request('hi');
  owner.req.headers.authorization = 'Bearer secret-token';
  await owner.promise;
  const requestId = getRequestTimingState(owner.req).requestId;
  const key = 'np:v1:test:public-news:hi';
  const freshTtl = harness.cache.getDeterministicSpreadTtlSeconds(45, key, 15);
  assert.ok(entries.some((entry) => entry.event === 'lookup' && entry.result === 'miss'));
  assert.ok(entries.some((entry) => entry.event === 'admission' && entry.result === 'admitted'));
  assert.ok(entries.some((entry) => entry.event === 'lock_acquire' && entry.result === 'acquired'));
  assert.ok(entries.some((entry) => entry.event === 'lock_owner' && entry.result === 'matched'));
  assert.ok(entries.some((entry) => entry.event === 'lock_release' && entry.result === 'released'));
  for (const [event, ttl] of [['write_fresh', freshTtl], ['write_stale', freshTtl + 45]]) {
    const writes = entries.filter((entry) => entry.event === event);
    assert.deepEqual(writes.map((entry) => entry.result), ['attempted', 'succeeded']);
    assert.ok(writes.every((entry) => entry.ttlSeconds === ttl));
  }
  assert.ok(entries.every((entry) => entry.requestId === requestId && entry.cacheKey === key));
  assert.equal(harness.redis.entries.get(key).expiresAt, freshTtl * 1000);
  assert.equal(harness.redis.entries.get(key + ':stale').expiresAt, (freshTtl + 45) * 1000);
  const hit = harness.request('hi');
  await hit.promise;
  assert.equal(calls, 1);
  assert.deepEqual(owner.res.body, body);
  assert.deepEqual(hit.res.body, body);
  const hitEntries = entries.filter((entry) => entry.requestId === getRequestTimingState(hit.req).requestId);
  assert.deepEqual(hitEntries.map((entry) => [entry.event, entry.result]), [['lookup', 'hit']]);
  assert.equal(/private-article|secret-token|authorization/.test(JSON.stringify(entries)), false);
  assert.equal(JSON.stringify(harness.redis.entries.get(key).value).includes(requestId), false);
});

for (const stage of ['fresh', 'stale']) {
  for (const fault of ['failure', 'timeout']) {
    test(`public-news diagnostics report ${stage} write ${fault} and preserve the 200 response`, async (t) => {
      const entries = captureCacheDiagnostics(t);
      const body = { items: [], page: 1, limit: 40, total: 0, totalPages: 1 };
      const harness = makeLifecycleHarness(t, async (_req, res) => res.json(body), { publicNewsDiagnostics: true });
      const key = 'np:v1:test:public-news:gu';
      const failedKey = stage === 'fresh' ? key : key + ':stale';
      const originalSet = harness.redis.set.bind(harness.redis);
      harness.redis.set = (target, ...args) => {
        if (target === failedKey) {
          if (fault === 'timeout') return new Promise(() => {});
          throw new Error('redis://user:secret-password@host private-article');
        }
        return originalSet(target, ...args);
      };
      const task = harness.request('gu');
      await flushPromises();
      if (fault === 'timeout') await harness.advance(21);
      await task.promise;
      const requestId = getRequestTimingState(task.req).requestId;
      const writes = entries.filter((entry) => entry.event === `write_${stage}`);
      assert.deepEqual(writes.map((entry) => entry.result), ['attempted', fault === 'timeout' ? 'timed_out' : 'failed']);
      assert.ok(writes.every((entry) => entry.requestId === requestId && entry.ttlSeconds >= 45));
      assert.equal(writes[1].reason, fault === 'timeout' ? 'command_timeout' : 'redis_command_failed');
      if (stage === 'fresh') {
        assert.ok(entries.some((entry) => entry.event === 'write_stale' && entry.result === 'skipped' && entry.reason === 'fresh_write_not_stored'));
        assert.ok(entries.some((entry) => entry.event === 'no_store' && entry.statusCode === 200));
      } else {
        assert.ok(entries.some((entry) => entry.event === 'storage' && entry.result === 'partial'));
        assert.ok(harness.redis.entries.has(key));
        assert.equal(entries.some((entry) => entry.event === 'no_store'), false);
      }
      assert.equal(task.res.statusCode, 200);
      assert.deepEqual(task.res.body, body);
      assert.equal(/secret|private-article|redis:\/\//.test(JSON.stringify(entries)), false);
    });
  }
}

for (const fault of ['failure', 'timeout', 'mismatch']) {
  test(`public-news diagnostics explain skipped writes after owner-check ${fault}`, async (t) => {
    const entries = captureCacheDiagnostics(t);
    const harness = makeLifecycleHarness(t, async (_req, res) => res.json({ items: [] }), { publicNewsDiagnostics: true });
    const originalGet = harness.redis.get.bind(harness.redis);
    let checked = false;
    harness.redis.get = (key) => {
      if (key.endsWith(':lock') && !checked) {
        checked = true;
        if (fault === 'timeout') return new Promise(() => {});
        if (fault === 'failure') return Promise.reject(new Error('redis://user:secret-password@host'));
        return Promise.resolve('secret-replacement-lock-token');
      }
      return originalGet(key);
    };
    const task = harness.request('hi');
    await flushPromises();
    if (fault === 'timeout') await harness.advance(21);
    await task.promise;
    assert.ok(entries.some((entry) => entry.event === 'lock_owner' && entry.result === ({ failure: 'failed', timeout: 'timed_out', mismatch: 'mismatch' })[fault]));
    for (const event of ['write_fresh', 'write_stale', 'no_store']) {
      const entry = entries.find((entry) => entry.event === event);
      assert.equal(entry.result, 'skipped');
      assert.ok(entry.reason);
      assert.equal(entry.requestId, getRequestTimingState(task.req).requestId);
    }
    assert.equal(harness.redis.entries.has('np:v1:test:public-news:hi'), false);
    assert.deepEqual(task.res.body, { items: [] });
    assert.equal(task.res.statusCode, 200);
    assert.equal(JSON.stringify(entries).includes('secret'), false);
  });
}

test('public-news diagnostics explain Redis-not-ready 200 rebuilds that cannot warm cache', async (t) => {
  const entries = captureCacheDiagnostics(t);
  let calls = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    calls += 1;
    res.json({ items: [] });
  }, { publicNewsDiagnostics: true, redisState: { ready: false } });
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const task = harness.request('hi');
    await task.promise;
    const correlated = entries.filter((entry) => entry.requestId === getRequestTimingState(task.req).requestId);
    assert.ok(correlated.some((entry) => entry.event === 'lookup' && entry.result === 'bypass'));
    assert.ok(correlated.some((entry) => entry.event === 'no_store' && entry.reason === 'redis_not_ready' && entry.redisReady === false && entry.statusCode === 200));
    assert.equal(task.res.statusCode, 200);
    assert.deepEqual(task.res.body, { items: [] });
  }
  assert.equal(calls, 2);
  assert.equal(harness.redis.entries.size, 0);
});

test('public-news stale-hit diagnostics retain request identity through background writes', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const harness = makeLifecycleHarness(t, async (_req, res) => res.json({ items: ['refreshed'] }), { publicNewsDiagnostics: true });
  await harness.cache.safeSetCache('np:v1:test:public-news:hi:stale', { status: 200, body: { items: ['stale'] } }, 45);
  const task = harness.request('hi');
  await task.promise;
  await flushPromises();
  assert.deepEqual(task.res.body, { items: ['stale'] });
  assert.ok(entries.some((entry) => entry.event === 'lookup' && entry.result === 'stale'));
  assert.ok(entries.some((entry) => entry.event === 'admission' && entry.result === 'admitted' && entry.mode === 'background'));
  assert.ok(entries.some((entry) => entry.event === 'write_stale' && entry.result === 'succeeded'));
  assert.ok(entries.every((entry) => entry.requestId === getRequestTimingState(task.req).requestId));
});

test('public-news diagnostics report bounded admission timeout without changing the 503 body', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const release = deferred();
  const harness = makeLifecycleHarness(t, async (_req, res) => { await release.promise; res.json({ items: [] }); }, { publicNewsDiagnostics: true });
  const first = harness.request('one');
  const second = harness.request('two');
  await flushPromises();
  const queued = harness.request('three');
  await flushPromises();
  await harness.advance(101);
  await queued.promise;
  assert.ok(entries.some((entry) => entry.requestId === getRequestTimingState(queued.req).requestId && entry.event === 'admission' && entry.result === 'timed_out'));
  assert.equal(queued.res.statusCode, 503);
  assert.deepEqual(queued.res.body, { items: [], page: 1, limit: 30, total: 0, totalPages: 1 });
  release.resolve();
  await Promise.all([first.promise, second.promise]);
});

test('cache lifecycle diagnostics remain opt-in', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const harness = makeLifecycleHarness(t, async (_req, res) => res.json({ items: [] }));
  await harness.request('disabled').promise;
  assert.equal(entries.length, 0);
});

test('public-news diagnostic logging failures cannot change writes or response JSON', async (t) => {
  t.mock.method(console, 'log', (tag) => {
    if (tag === '[cache][public-news]') throw new Error('logger unavailable');
  });
  let calls = 0;
  const harness = makeLifecycleHarness(t, async (_req, res) => {
    calls += 1;
    res.json({ items: [] });
  }, { publicNewsDiagnostics: true });
  const first = harness.request('hi');
  await first.promise;
  const second = harness.request('hi');
  await second.promise;
  assert.equal(calls, 1);
  assert.equal(first.res.statusCode, 200);
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(first.res.body, { items: [] });
  assert.deepEqual(second.res.body, { items: [] });
});

test('public-news diagnostics explain an uncacheable 200 without changing its JSON', async (t) => {
  const entries = captureCacheDiagnostics(t);
  const body = { message: 'private-response' };
  const harness = makeLifecycleHarness(t, async (_req, res) => res.json(body), { publicNewsDiagnostics: true });
  const task = harness.request('hi');
  await task.promise;
  assert.equal(task.res.statusCode, 200);
  assert.deepEqual(task.res.body, body);
  assert.ok(entries.some((entry) => entry.event === 'no_store' && entry.reason === 'response_not_cacheable' && entry.statusCode === 200));
  assert.equal(entries.some((entry) => entry.result === 'attempted'), false);
  assert.equal(harness.redis.entries.size, 0);
  assert.equal(JSON.stringify(entries).includes('private-response'), false);
});

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