const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /admin-api/media/items returns 401 JSON when unauthenticated', async () => {
  const res = await request(app)
    .get('/admin-api/media/items')
    .set('Accept', 'application/json');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized');
});

test('GET /admin-api/media/stats returns 401 JSON when unauthenticated', async () => {
  const res = await request(app)
    .get('/admin-api/media/stats')
    .set('Accept', 'application/json');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized');
});

test('POST /api/admin/media-library/sync-cloudinary returns 401 JSON when unauthenticated', async () => {
  const res = await request(app)
    .post('/api/admin/media-library/sync-cloudinary')
    .set('Accept', 'application/json');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized');
});

test('GET /api/admin/media-library/unused returns 401 JSON when unauthenticated', async () => {
  const res = await request(app)
    .get('/api/admin/media-library/unused')
    .set('Accept', 'application/json');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized');
});
