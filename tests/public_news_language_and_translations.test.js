const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

test('GET /api/public/news supports language=en and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?category=national&language=en&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(typeof res.body.page, 'number');
  assert.equal(typeof res.body.limit, 'number');
  assert.equal(typeof res.body.total, 'number');
  assert.equal(typeof res.body.totalPages, 'number');
});

test('GET /api/public/news supports language=hi and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?category=national&language=hi&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /api/public/news supports q + language and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?q=budget&language=en&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /api/public/news/translations/:translationGroupId returns 200 and an array', async () => {
  const res = await request(app).get('/api/public/news/translations/test-group');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});
