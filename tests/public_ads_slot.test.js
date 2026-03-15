const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /api/public/ads without slot returns {enabled:false, ad:null}', async () => {
  const res = await request(app).get('/api/public/ads');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { enabled: false, ad: null, reason: 'invalid_slot' });
});

test('GET /api/public/ads?slot=ARTICLE_INLINE returns stable shape when DB is not connected', async () => {
  const res = await request(app).get('/api/public/ads?slot=ARTICLE_INLINE');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
  assert.equal(res.body.reason, 'db_unavailable');
});

test('GET /api/public/ads?slot=article inline accepts normalized slot label', async () => {
  const res = await request(app).get('/api/public/ads?slot=article inline');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
});

test('GET /api/public/ads?slot=HOME_RIGHT_RAIL aliases to HOME_RIGHT_300x250', async () => {
  const resLegacy = await request(app).get('/api/public/ads?slot=HOME_RIGHT_RAIL');
  const resCanonical = await request(app).get('/api/public/ads?slot=HOME_RIGHT_300x250');

  assert.equal(resLegacy.status, 200);
  assert.equal(resCanonical.status, 200);

  // In NODE_ENV=test the DB is typically not connected for this suite,
  // so both should return the same stable fallback.
  assert.deepEqual(resLegacy.body, resCanonical.body);
});
