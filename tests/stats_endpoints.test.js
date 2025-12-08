const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

// Basic availability tests for stats endpoints

test('GET /api/stats returns 200 and JSON', async () => {
  const res = await request(app).get('/api/stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  // Accept either health shape or stats shape
  const isHealthShape = res.body && res.body.ok && res.body.data && typeof res.body.data === 'object';
  const isStatsShape = res.body && res.body.ok && res.body.stats && typeof res.body.stats === 'object';
  assert.ok(isHealthShape || isStatsShape);
});

test('GET /api/dashboard-stats returns 200 and JSON', async () => {
  const res = await request(app).get('/api/dashboard-stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok);
  const isOldShape = !!res.body.stats;
  const isNewShape = !!res.body.data;
  assert.ok(isOldShape || isNewShape);
});

// Admin alias via /admin-api

test('GET /admin-api/stats returns 200', async () => {
  const res = await request(app).get('/admin-api/stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
});

test('GET /admin-api/dashboard-stats returns 200', async () => {
  const res = await request(app).get('/admin-api/dashboard-stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok);
  const isOldShape = !!res.body.stats;
  const isNewShape = !!res.body.data;
  assert.ok(isOldShape || isNewShape);
});
