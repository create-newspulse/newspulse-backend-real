const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

// server.js exports the Express app instance.
const app = require('../server');

test('Broadcast Center: GET /api/broadcast/settings returns 200 JSON', async () => {
  const res = await request(app)
    .get('/api/broadcast/settings')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.breakingEnabled, 'boolean');
  assert.ok(res.body.breakingMode === 'manual' || res.body.breakingMode === 'auto');
  assert.equal(typeof res.body.liveEnabled, 'boolean');
  assert.ok(res.body.liveMode === 'manual' || res.body.liveMode === 'auto');
});

test('Broadcast Center: GET /api/broadcast/items?type=live returns 200', async () => {
  const res = await request(app)
    .get('/api/broadcast/items?type=live')
    .expect(200);

  assert.ok(Array.isArray(res.body));
});
