const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Public Broadcast Center: GET /api/public/broadcast?detailed=1 returns detailed payload with id mapping', async () => {
  const res = await request(app)
    .get('/api/public/broadcast?detailed=1')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.breaking, 'object');
  assert.equal(typeof res.body.live, 'object');

  for (const key of ['breaking', 'live']) {
    assert.equal(typeof res.body[key].enabled, 'boolean');
    assert.equal(typeof res.body[key].mode, 'string');
    assert.ok(typeof res.body[key].speed === 'number' || typeof res.body[key].speedSec === 'number');
    assert.ok(Array.isArray(res.body[key].items));
  }

  // No-cache headers for public broadcast endpoints
  assert.ok(String(res.headers['cache-control'] || '').includes('no-store'));
});
