const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

// Verify /api/admin/community-reporter/queue is protected and returns 200 with legacy cookie

test('GET /api/admin/community-reporter/queue without auth returns 401', async () => {
  const res = await request(app).get('/api/admin/community-reporter/queue?status=pending');
  assert.equal(res.status, 401);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok === false);
});

test('GET /api/admin/community-reporter/queue with legacy cookie returns 200 JSON', async () => {
  const res = await request(app)
    .get('/api/admin/community-reporter/queue?status=pending')
    .set('Cookie', 'np_admin=admin@example.com');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok === true);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.meta && typeof res.body.meta === 'object');
});

test('GET /api/admin/community-reporter/queue with bearer token returns 200 JSON', async () => {
  // Use accepted opaque admin token (prefix np.) handled by requireAdminAuth
  const res = await request(app)
    .get('/api/admin/community-reporter/queue?status=pending')
    .set('Authorization', 'Bearer np.testing-token');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok === true);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.meta && typeof res.body.meta === 'object');
});
