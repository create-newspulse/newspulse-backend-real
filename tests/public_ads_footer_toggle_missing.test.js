const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const AdSettings = require('../models/AdSettings');

const app = require('../server');

test('Public ads: missing FOOTER_BANNER_728x90 toggle key => enabled:false (200), not 400', async (t) => {
  // This test simulates a DB-ready environment without a real DB by stubbing
  // the mongoose readyState + model methods used by the controller.
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = Ad.find;
  const prevFindSettings = AdSettings.findByIdAndUpdate;
  const prevUpdateOne = AdSettings.updateOne;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    Ad.find = prevFind;
    AdSettings.findByIdAndUpdate = prevFindSettings;
    AdSettings.updateOne = prevUpdateOne;
  });

  // Pretend DB is connected so controller goes through toggle + selection logic.
  mongoose.connection.readyState = 1;

  // Return an older slotEnabled object missing the footer key.
  AdSettings.findByIdAndUpdate = () => ({
    lean: async () => ({
      _id: 'global',
      slotEnabled: {
        HOME_728x90: true,
        HOME_RIGHT_300x250: true,
        HOME_RIGHT_RAIL: true,
        ARTICLE_INLINE: true,
        ARTICLE_END: true,
        // FOOTER_BANNER_728x90 intentionally missing
      },
    }),
  });

  // Backfill is best-effort; keep it a no-op.
  AdSettings.updateOne = async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });

  // No active ads.
  Ad.find = () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => ([]),
  });

  const res = await request(app).get('/api/public/ads?slot=FOOTER_BANNER_728x90&lang=en');

  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.ok, false);

  assert.deepEqual(res.body && typeof res.body === 'object' ? { enabled: res.body.enabled, ad: res.body.ad } : res.body, {
    enabled: false,
    ad: null,
  });
});


test('Public ads: explicit FOOTER_BANNER_728x90 toggle true + no active ad => enabled:true, ad:null (200)', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = Ad.find;
  const prevFindSettings = AdSettings.findByIdAndUpdate;
  const prevUpdateOne = AdSettings.updateOne;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    Ad.find = prevFind;
    AdSettings.findByIdAndUpdate = prevFindSettings;
    AdSettings.updateOne = prevUpdateOne;
  });

  mongoose.connection.readyState = 1;

  AdSettings.findByIdAndUpdate = () => ({
    lean: async () => ({
      _id: 'global',
      slotEnabled: {
        HOME_728x90: true,
        HOME_RIGHT_300x250: true,
        HOME_RIGHT_RAIL: true,
        ARTICLE_INLINE: true,
        ARTICLE_END: true,
        FOOTER_BANNER_728x90: true,
      },
    }),
  });
  AdSettings.updateOne = async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 0 });

  Ad.find = () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => ([]),
  });

  const res = await request(app).get('/api/public/ads?slot=FOOTER_BANNER_728x90');

  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers.expires, '0');
  assert.equal(res.body.ok, false);

  assert.deepEqual({ enabled: res.body.enabled, ad: res.body.ad }, { enabled: true, ad: null });
});
