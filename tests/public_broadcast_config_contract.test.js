const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /api/public/broadcast/config exposes speedSec + maxItems + pauseOnHover', async () => {
  const res = await request(app)
    .get('/api/public/broadcast/config')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.version, 'number');

  // New flat fields
  assert.equal(typeof res.body.breakingSpeedSec, 'number');
  assert.equal(typeof res.body.liveSpeedSec, 'number');
  assert.equal(typeof res.body.breakingMaxItems, 'number');
  assert.equal(typeof res.body.liveMaxItems, 'number');
  assert.equal(typeof res.body.pauseOnHover, 'boolean');

  // Existing nested contract still present
  assert.equal(typeof res.body.breaking, 'object');
  assert.equal(typeof res.body.live, 'object');
  assert.equal(typeof res.body.breaking.durationSec, 'number');
  assert.equal(typeof res.body.live.durationSec, 'number');

  const cc = String(res.headers['cache-control'] || '');
  assert.ok(cc.includes('no-store'));
});
