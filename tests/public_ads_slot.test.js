const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /api/public/ads without slot returns {enabled:false, ad:null}', async () => {
  const res = await request(app).get('/api/public/ads');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.deepEqual(res.body, { ok: false, enabled: false, ad: null });
});

test('GET /api/public/ads?slot=ARTICLE_INLINE returns stable shape when DB is not connected', async () => {
  const res = await request(app).get('/api/public/ads?slot=ARTICLE_INLINE');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
});

test('GET /api/public/ads?slot=FOOTER_BANNER_728x90 returns stable shape when DB is not connected', async () => {
  const res = await request(app).get('/api/public/ads?slot=FOOTER_BANNER_728x90');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
});

test('GET /api/public/ads?slot=FOOTER_BANNER_728x90&lang=en returns 200', async () => {
  const res = await request(app).get('/api/public/ads?slot=FOOTER_BANNER_728x90&lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
});

test('GET /api/public/ads returns 200 (not 400) for new valid slots', async () => {
  const slots = ['HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250', 'BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR'];
  for (const slot of slots) {
    const res = await request(app).get(`/api/public/ads?slot=${encodeURIComponent(slot)}&lang=en`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(res.headers.pragma, 'no-cache');
    assert.equal(res.headers.expires, '0');
    assert.equal(res.body.ok, false);
    assert.equal(typeof res.body.enabled, 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'ad'));
  }
});

test('GET /api/public/ads?slot=article inline accepts normalized slot label', async () => {
  const res = await request(app).get('/api/public/ads?slot=article inline');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.ad, null);
});

test('GET /api/public/ads?slot=UNKNOWN does not 400 (stable shape)', async () => {
  const res = await request(app).get('/api/public/ads?slot=__NOT_A_REAL_SLOT__&lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.deepEqual(res.body, { ok: false, enabled: false, ad: null });
});

test('GET /api/public/ads?slot=HOME_RIGHT_RAIL aliases to HOME_RIGHT_300x250', async () => {
  const resLegacy = await request(app).get('/api/public/ads?slot=HOME_RIGHT_RAIL');
  const resCanonical = await request(app).get('/api/public/ads?slot=HOME_RIGHT_300x250');

  assert.equal(resLegacy.status, 200);
  assert.equal(resCanonical.status, 200);

  assert.equal(resLegacy.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(resLegacy.headers.pragma, 'no-cache');
  assert.equal(resLegacy.headers.expires, '0');
  assert.equal(resCanonical.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(resCanonical.headers.pragma, 'no-cache');
  assert.equal(resCanonical.headers.expires, '0');

  // In NODE_ENV=test the DB is typically not connected for this suite,
  // so both should return the same stable fallback.
  assert.deepEqual(resLegacy.body, resCanonical.body);
});
