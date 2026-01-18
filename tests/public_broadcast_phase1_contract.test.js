const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Public Broadcast Center Phase 1: GET /admin-api/public/broadcast?lang=en returns breaking+live with durationSeconds', async () => {
  const res = await request(app)
    .get('/admin-api/public/broadcast?lang=en')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.breaking, 'object');
  assert.equal(typeof res.body.live, 'object');

  for (const key of ['breaking', 'live']) {
    assert.equal(typeof res.body[key].enabled, 'boolean');
    assert.equal(typeof res.body[key].durationSeconds, 'number');
    assert.ok(Array.isArray(res.body[key].items));
  }

  const cc = String(res.headers['cache-control'] || '');
  assert.ok(cc.includes('no-store'));
});
