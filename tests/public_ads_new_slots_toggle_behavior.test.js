const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const AdSettings = require('../models/AdSettings');

const app = require('../server');

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = 1;
}

function stubSettings(t, slotEnabled) {
  const prevFindSettings = AdSettings.findByIdAndUpdate;
  const prevUpdateOne = AdSettings.updateOne;
  t.after(() => {
    AdSettings.findByIdAndUpdate = prevFindSettings;
    AdSettings.updateOne = prevUpdateOne;
  });

  AdSettings.findByIdAndUpdate = () => ({
    lean: async () => ({
      _id: 'global',
      slotEnabled,
    }),
  });
  AdSettings.updateOne = async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
}

function stubAdsFind(t, ads) {
  const prevFind = Ad.find;
  t.after(() => { Ad.find = prevFind; });

  Ad.find = () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => (Array.isArray(ads) ? ads : []),
  });
}

test('Public ads: toggle OFF => ok:false enabled:false ad:null for new slots', async (t) => {
  stubDbReady(t);
  stubSettings(t, {
    HOME_728x90: true,
    HOME_LEFT_300x250: false,
    HOME_LEFT_300x600: false,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
    HOME_RIGHT_300x600: false,
    HOME_BILLBOARD_970x250: false,
    BREAKING_SPONSOR: false,
  });
  stubAdsFind(t, []);

  for (const slot of ['HOME_LEFT_300x250', 'HOME_LEFT_300x600', 'HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250', 'BREAKING_SPONSOR']) {
    const res = await request(app).get(`/api/public/ads?slot=${encodeURIComponent(slot)}&lang=en`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: false, enabled: false, ad: null });
  }
});

test('Public ads: toggle ON + no ad => ok:false enabled:true ad:null for new slots', async (t) => {
  stubDbReady(t);
  stubSettings(t, {
    HOME_728x90: true,
    HOME_LEFT_300x250: true,
    HOME_LEFT_300x600: true,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
    HOME_RIGHT_300x600: true,
    HOME_BILLBOARD_970x250: true,
    BREAKING_SPONSOR: true,
  });
  stubAdsFind(t, []);

  for (const slot of ['HOME_LEFT_300x250', 'HOME_LEFT_300x600', 'HOME_RIGHT_300x600', 'HOME_BILLBOARD_970x250', 'BREAKING_SPONSOR']) {
    const res = await request(app).get(`/api/public/ads?slot=${encodeURIComponent(slot)}&lang=en`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: false, enabled: true, ad: null });
  }
});

test('Public ads: toggle ON + ad exists => ok:true enabled:true ad:{...} for new slots', async (t) => {
  stubDbReady(t);
  stubSettings(t, {
    HOME_728x90: true,
    HOME_LEFT_300x250: true,
    HOME_LEFT_300x600: true,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
    HOME_RIGHT_300x600: true,
    HOME_BILLBOARD_970x250: true,
    BREAKING_SPONSOR: true,
  });

  // Return one active ad for whichever slot the controller queries.
  // We stub twice (once per slot) so each request gets the expected ad slot.
  {
    stubAdsFind(t, [{
      _id: '507f1f77bcf86cd799439010',
      slot: 'HOME_LEFT_300x600',
      title: 'Test Left Tower',
      imageUrl: 'https://example.com/left-tower.jpg',
      isClickable: true,
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: null,
      endAt: null,
      priority: 10,
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    }]);

    const res = await request(app).get('/api/public/ads?slot=HOME_LEFT_300x600&lang=en');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.ad && typeof res.body.ad === 'object');
    assert.equal(res.body.ad.slot, 'HOME_LEFT_300x600');
  }

  {
    stubAdsFind(t, [{
      _id: '507f1f77bcf86cd799439011',
      slot: 'HOME_LEFT_300x250',
      title: 'Test Left Rail',
      imageUrl: 'https://example.com/left-rail.jpg',
      isClickable: true,
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: null,
      endAt: null,
      priority: 10,
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    }]);

    const res = await request(app).get('/api/public/ads?slot=HOME_LEFT_300x250&lang=en');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.ad && typeof res.body.ad === 'object');
    assert.equal(res.body.ad.slot, 'HOME_LEFT_300x250');
  }

  {
    stubAdsFind(t, [{
      _id: '507f1f77bcf86cd799439012',
      slot: 'HOME_RIGHT_300x600',
      title: 'Test Ad 300x600',
      imageUrl: 'https://example.com/ad.jpg',
      isClickable: true,
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: null,
      endAt: null,
      priority: 10,
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    }]);

    const res = await request(app).get('/api/public/ads?slot=HOME_RIGHT_300x600&lang=en');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.ad && typeof res.body.ad === 'object');
    assert.equal(res.body.ad.slot, 'HOME_RIGHT_300x600');
  }

  {
    stubAdsFind(t, [{
      _id: '507f1f77bcf86cd799439013',
      slot: 'HOME_BILLBOARD_970x250',
      title: 'Test Billboard',
      imageUrl: 'https://example.com/billboard.jpg',
      isClickable: true,
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: null,
      endAt: null,
      priority: 10,
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    }]);

    const res = await request(app).get('/api/public/ads?slot=HOME_BILLBOARD_970x250&lang=en');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.ad && typeof res.body.ad === 'object');
    assert.equal(res.body.ad.slot, 'HOME_BILLBOARD_970x250');
  }

  {
    stubAdsFind(t, [{
      _id: '507f1f77bcf86cd799439014',
      slot: 'BREAKING_SPONSOR',
      title: 'Breaking Sponsor',
      imageUrl: 'https://example.com/breaking-sponsor.jpg',
      isClickable: true,
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: null,
      endAt: null,
      priority: 10,
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    }]);

    const res = await request(app).get('/api/public/ads?slot=BREAKING_SPONSOR&lang=en');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.ad && typeof res.body.ad === 'object');
    assert.equal(res.body.ad.slot, 'BREAKING_SPONSOR');
  }
});
