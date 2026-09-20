const assert = require('node:assert/strict');
const test = require('node:test');
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

function makePublicNewsCacheApp(cache, handler, options = {}) {
  const app = express();
  const routeHandler = options.routeHandler || handler;
  app.get('/cached/:key?', cache.createJsonCacheMiddleware({
    ttlSeconds: options.ttlSeconds || 45,
    staleWhileRevalidate: true,
    backgroundRebuild: handler,
    deterministicTtlSpreadSeconds: 15,
    rebuildConcurrencyGroup: options.rebuildConcurrencyGroup || `public-news-test-${Date.now()}-${Math.random()}`,
    rebuildConcurrencyLimit: options.rebuildConcurrencyLimit || 2,
    lockTtlSeconds: 60,
    coldCacheWaitMs: options.coldCacheWaitMs || 180,
    coldCachePollMs: 15,
    buildKey: (req) => `np:v1:test:public-news:${req.params.key || 'default'}`,
    shouldCache: ({ statusCode, body }) => statusCode === 200 && body && Array.isArray(body.items),
  }), routeHandler);
  return app;
}

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