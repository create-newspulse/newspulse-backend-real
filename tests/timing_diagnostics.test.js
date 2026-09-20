const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const {
  createRequestTimingMiddleware,
  logSlowTiming,
  setRequestTimingCacheContext,
  setRequestTimingCacheStatus,
  timeAsync,
} = require('../lib/timingDiagnostics');

function captureLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      log(tag, payload) {
        entries.push({ tag, payload });
      },
    },
  };
}

test('request timing middleware logs only safe slow-request metadata', async () => {
  const capture = captureLogger();
  const app = express();

  app.use(createRequestTimingMiddleware({ thresholdMs: 0, logger: capture.logger }));
  app.get('/safe/:id', (req, res) => {
    setRequestTimingCacheStatus(req, 'miss');
    return res.status(202).json({ ok: true });
  });

  await request(app)
    .get('/safe/secret-id?token=secret-token')
    .set('Authorization', 'Bearer secret-token')
    .set('Cookie', 'session=secret-cookie')
    .expect(202);

  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].tag, '[perf][http.request]');
  assert.deepEqual(Object.keys(capture.entries[0].payload).sort(), [
    'cache',
    'durationMs',
    'method',
    'route',
    'statusCode',
  ].sort());
  assert.equal(capture.entries[0].payload.method, 'GET');
  assert.equal(capture.entries[0].payload.route, '/safe/:id');
  assert.equal(capture.entries[0].payload.statusCode, 202);
  assert.equal(capture.entries[0].payload.cache, 'miss');
  assert.ok(Number.isFinite(capture.entries[0].payload.durationMs));
  assert.equal(JSON.stringify(capture.entries[0].payload).includes('secret'), false);
});

test('timeAsync logs safe operation metadata and preserves return value', async () => {
  const capture = captureLogger();
  const req = { method: 'GET', originalUrl: '/api/public/news?lang=en' };
  const res = { statusCode: 200 };
  setRequestTimingCacheStatus(req, 'rebuild');

  const value = await timeAsync('mongo.publicNews.latest.find', {
    req,
    res,
    thresholdMs: 0,
    logger: capture.logger,
    getResultMetadata: (result) => ({ resultCount: Array.isArray(result) ? result.length : 0 }),
  }, async () => [{ ok: true }, { ok: true }]);

  assert.deepEqual(value, [{ ok: true }, { ok: true }]);
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].tag, '[perf][mongo.publicNews.latest.find]');
  assert.deepEqual(capture.entries[0].payload, {
    method: 'GET',
    route: '/api/public/news',
    durationMs: capture.entries[0].payload.durationMs,
    statusCode: 200,
    cache: 'rebuild',
    resultCount: 2,
  });
  assert.ok(Number.isFinite(capture.entries[0].payload.durationMs));
});

test('timeAsync logs safe count metadata after operation completes', async () => {
  const capture = captureLogger();
  const req = { method: 'GET', originalUrl: '/api/public/news?lang=gu' };
  const res = { statusCode: 200 };

  const value = await timeAsync('mongo.publicNews.latest.count', {
    req,
    res,
    thresholdMs: 0,
    logger: capture.logger,
    getResultMetadata: (result) => ({ countResult: Number(result) }),
  }, async () => 42);

  assert.equal(value, 42);
  assert.equal(capture.entries[0].tag, '[perf][mongo.publicNews.latest.count]');
  assert.equal(capture.entries[0].payload.countResult, 42);
});

test('timing diagnostics include safe public-news cache context', async () => {
  const capture = captureLogger();
  const req = { method: 'GET', originalUrl: '/api/public/news?category=national&lang=gu&page=1' };
  const res = { statusCode: 200 };
  setRequestTimingCacheStatus(req, 'rebuild');
  setRequestTimingCacheContext(req, {
    cacheFamily: 'category',
    cacheKey: 'np:v1:category:national:gu:page:1',
    language: 'gu',
    category: 'national',
    page: 1,
  });

  await timeAsync('mongo.publicNews.category.siblings.find', {
    req,
    res,
    thresholdMs: 0,
    logger: capture.logger,
    getResultMetadata: (result) => ({ resultCount: Array.isArray(result) ? result.length : 0 }),
  }, async () => [{ ok: true }]);

  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].tag, '[perf][mongo.publicNews.category.siblings.find]');
  assert.deepEqual(capture.entries[0].payload, {
    method: 'GET',
    route: '/api/public/news',
    durationMs: capture.entries[0].payload.durationMs,
    statusCode: 200,
    cache: 'rebuild',
    cacheFamily: 'category',
    cacheKey: 'np:v1:category:national:gu:page:1',
    language: 'gu',
    category: 'national',
    page: 1,
    resultCount: 1,
  });
});

test('timing diagnostics ignore unsupported cache context and private extras', async () => {
  const capture = captureLogger();
  const req = { method: 'GET', originalUrl: '/api/public/news?token=secret-token' };
  const res = { statusCode: 200 };
  setRequestTimingCacheStatus(req, 'rebuild');
  setRequestTimingCacheContext(req, {
    cacheFamily: 'latest',
    cacheKey: 'np:v1:latest:en',
    language: 'en',
    category: 'person@example.com',
    page: 'not-a-page',
    authorization: 'Bearer secret-token',
    cookie: 'session=secret-cookie',
    requestBody: { password: 'secret-password' },
  });

  await timeAsync('mongo.publicNews.latest.count', {
    req,
    res,
    thresholdMs: 0,
    logger: capture.logger,
    getResultMetadata: (result) => ({ countResult: Number(result) }),
  }, async () => 14);

  assert.deepEqual(capture.entries[0].payload, {
    method: 'GET',
    route: '/api/public/news',
    durationMs: capture.entries[0].payload.durationMs,
    statusCode: 200,
    cache: 'rebuild',
    cacheFamily: 'latest',
    cacheKey: 'np:v1:latest:en',
    language: 'en',
    countResult: 14,
  });
  assert.equal(JSON.stringify(capture.entries[0].payload).includes('secret'), false);
  assert.equal(JSON.stringify(capture.entries[0].payload).includes('@example.com'), false);
});

test('logSlowTiming suppresses operations below threshold', () => {
  const capture = captureLogger();
  const logged = logSlowTiming('mongo.publicNews.latest.find', {
    req: { method: 'GET', originalUrl: '/api/public/news' },
    res: { statusCode: 200 },
    durationMs: 999,
    thresholdMs: 1000,
    logger: capture.logger,
  });

  assert.equal(logged, false);
  assert.equal(capture.entries.length, 0);
});