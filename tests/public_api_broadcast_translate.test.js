const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Public API Broadcast: GET /public-api/broadcast returns stable payload', async () => {
  const res = await request(app)
    .get('/public-api/broadcast')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(res.body && typeof res.body, 'object');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);

  assert.equal(typeof res.body.data, 'object');
  assert.equal(typeof res.body.data.breaking, 'object');
  assert.equal(typeof res.body.data.live, 'object');

  for (const key of ['breaking', 'live']) {
    assert.equal(typeof res.body.data[key].enabled, 'boolean');
    assert.equal(typeof res.body.data[key].mode, 'string');
    assert.equal(typeof res.body.data[key].durationSec, 'number');
    // Backward-compat keys must mirror durationSec.
    for (const k of ['tickerSpeedSeconds', 'durationSeconds', 'speed', 'speedSec']) {
      assert.equal(typeof res.body.data[key][k], 'number');
      assert.equal(res.body.data[key][k], res.body.data[key].durationSec);
    }
    assert.ok(Array.isArray(res.body.data[key].items));
  }
});

test('Public API Broadcast: CORS override applies for allowed origin', async () => {
  const res = await request(app)
    .get('/public-api/broadcast?lang=gu')
    .set('Origin', 'https://www.newspulse.co.in')
    .expect(200);

  assert.equal(res.headers['access-control-allow-origin'], 'https://www.newspulse.co.in');
});

test('Public API Broadcast: lang=en falls back without GOOGLE_TRANSLATE_API_KEY', async () => {
  const res = await request(app)
    .get('/public-api/broadcast?lang=en&nocache=1')
    .expect(200);

  // If the env key exists in the test environment, translation may succeed.
  // The contract we care about: route must never error and must return stable JSON.
  assert.equal(res.body && typeof res.body, 'object');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.data, 'object');
  assert.ok(
    res.body.data.translationFallback === true || res.body.data.translationFallback === undefined,
    'translationFallback is optional but should be boolean when present'
  );
});
