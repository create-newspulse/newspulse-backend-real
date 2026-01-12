const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// server.js exports the Express app instance.
const app = require('../server');

test('Public Broadcast Center: GET /api/public/broadcast returns stable payload', async () => {
  const res = await request(app)
    .get('/api/public/broadcast')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.breaking, 'object');
  assert.equal(typeof res.body.live, 'object');

  for (const key of ['breaking', 'live']) {
    assert.equal(typeof res.body[key].enabled, 'boolean');
    assert.equal(typeof res.body[key].speedSec, 'number');
    assert.ok(Array.isArray(res.body[key].items));
  }
});
