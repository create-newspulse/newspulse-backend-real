const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');

const {
  createRequestTimingMiddleware,
  logSlowTiming,
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

  const value = await timeAsync('mongo.publicNews.latest.findAndCount', {
    req,
    res,
    thresholdMs: 0,
    logger: capture.logger,
  }, async () => ({ ok: true }));

  assert.deepEqual(value, { ok: true });
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0].tag, '[perf][mongo.publicNews.latest.findAndCount]');
  assert.deepEqual(capture.entries[0].payload, {
    method: 'GET',
    route: '/api/public/news',
    durationMs: capture.entries[0].payload.durationMs,
    statusCode: 200,
    cache: 'rebuild',
  });
  assert.ok(Number.isFinite(capture.entries[0].payload.durationMs));
});

test('logSlowTiming suppresses operations below threshold', () => {
  const capture = captureLogger();
  const logged = logSlowTiming('mongo.publicNews.latest.findAndCount', {
    req: { method: 'GET', originalUrl: '/api/public/news' },
    res: { statusCode: 200 },
    durationMs: 999,
    thresholdMs: 1000,
    logger: capture.logger,
  });

  assert.equal(logged, false);
  assert.equal(capture.entries.length, 0);
});