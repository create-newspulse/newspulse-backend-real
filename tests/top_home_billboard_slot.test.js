process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'top-home-billboard-isolated-test-secret';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const AdSettings = require('../models/AdSettings');
const AdPlacementSettings = require('../models/AdPlacementSettings');
const PublicConfigVersion = require('../models/PublicConfigVersion');
const User = require('../models/User');
const settingsStore = require('../services/adSettingsStore');
const adminAdsRouter = require('../routes/adminAds.routes');
const adminSettingsRouter = require('../routes/adminAdSettings.routes');
const publicSettingsRouter = require('../routes/publicAdSettings.routes');
const publicAdsRouter = require('../routes/publicAds.routes');

const SLOT = 'TOP_HOME_BILLBOARD_970x250';
const EXISTING_DEFAULTS = {
  HOME_728x90: true,
  HOME_BILLBOARD_970x250: false,
  HOME_LEFT_300x250: false,
  HOME_LEFT_300x600: false,
  HOME_RIGHT_300x250: true,
  HOME_RIGHT_300x600: false,
  HOME_RIGHT_RAIL: true,
  ARTICLE_INLINE: true,
  ARTICLE_END: true,
  FOOTER_BANNER_728x90: true,
  BREAKING_SPONSOR: false,
  LIVE_UPDATE_SPONSOR: false,
};
const PUBLIC_AD_KEYS = [
  'id', 'slot', 'title', 'imageUrl', 'isClickable', 'targetUrl',
  'startAt', 'endAt', 'priority', 'updatedAt',
].sort();
const ADMIN_AD_KEYS = [
  ...PUBLIC_AD_KEYS, 'originalImageUrl', 'isActive', 'createdBy', 'createdAt', 'stats',
].sort();

const app = express();
app.use(express.json());
app.use('/api/admin', adminAdsRouter, adminSettingsRouter);
app.use('/api/public', publicAdsRouter, publicSettingsRouter);

function auth(req) {
  const token = jwt.sign({
    sub: '507f1f77bcf86cd799439101', role: 'founder', type: 'access', tokenVersion: 0,
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`);
}

test.beforeEach((t) => {
  const readyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = readyState; });
  t.mock.method(User, 'findById', () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439101',
    email: 'founder@example.test', role: 'founder', status: 'active',
    isFounder: true, noExpiry: true, tokenVersion: 0,
  }) }));
  t.mock.method(PublicConfigVersion, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(PublicConfigVersion, 'findOneAndUpdate', (_filter, update) => ({
    lean: async () => update.$set,
  }));
});

function stubSettings(t, initial) {
  let stored = initial;
  t.mock.method(AdSettings, 'findByIdAndUpdate', (_id, update) => {
    if (update.$set) stored = update.$set.slotEnabled;
    return { lean: async () => ({ _id: 'global', slotEnabled: stored }) };
  });
  t.mock.method(AdSettings, 'updateOne', async (_filter, update) => {
    stored = update.$set.slotEnabled;
    return { acknowledged: true };
  });
  return () => stored;
}

function makeAd(slot = SLOT, values = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), slot, title: slot,
    imageUrl: 'https://res.cloudinary.com/example/image/upload/ad.png',
    isClickable: true, targetUrl: 'https://example.test',
    isActive: true, startAt: null, endAt: null, priority: 0,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...values,
  };
}

function stubPublicAds(t, ads) {
  const filters = [];
  t.mock.method(Ad, 'find', (filter) => {
    filters.push(filter);
    let rows = ads.filter((ad) => filter.slot.$in.includes(ad.slot) && ad.isActive === filter.isActive);
    return {
      sort(order) {
        assert.deepEqual(order, { priority: -1, updatedAt: -1 });
        rows.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
        return this;
      },
      limit(count) {
        assert.equal(count, 100);
        rows = rows.slice(0, count);
        return this;
      },
      lean: async () => rows,
    };
  });
  return filters;
}

test('top-home defaults and legacy normalization preserve every existing slot', async (t) => {
  const expected = { ...EXISTING_DEFAULTS, [SLOT]: false };
  for (const Model of [AdSettings, AdPlacementSettings]) {
    assert.deepEqual(Object.fromEntries(new Model().slotEnabled), expected);
  }
  assert.deepEqual(settingsStore.DEFAULT_SLOT_ENABLED, expected);
  for (const raw of [null, {}, new Map()]) {
    assert.equal(settingsStore.normalizeSlotEnabled(raw)[SLOT], false);
    stubSettings(t, raw);
    const res = await request(app).get('/api/public/ad-settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.slotEnabled[SLOT], false);
  }
  for (const value of [undefined, false, true]) {
    for (const enabled of [false, true]) {
      const old = Object.fromEntries(Object.keys(EXISTING_DEFAULTS).map((key) => [key, enabled]));
      const raw = { ...old, ...(value === undefined ? {} : { [SLOT]: value }) };
      const normalized = { ...old, [SLOT]: value === true };
      assert.deepEqual(settingsStore.normalizeSlotEnabled(raw), normalized);
      assert.deepEqual(settingsStore.normalizeSlotEnabled(new Map(Object.entries(raw))), normalized);
      stubSettings(t, raw);
      assert.deepEqual(await settingsStore.readSettings(), normalized);
      const res = await auth(request(app).get('/api/admin/ad-settings'));
      assert.deepEqual(res.body, { ok: true, slotEnabled: normalized });
    }
  }
  mongoose.connection.readyState = 0;
  const offline = await request(app).get('/api/public/ad-settings');
  assert.deepEqual(offline.body, { ok: true, slotEnabled: expected });
});

test('older full-map saves preserve top-home OFF/ON and all existing stored values', async (t) => {
  for (const value of [undefined, false, true]) {
    const old = { ...EXISTING_DEFAULTS, HOME_BILLBOARD_970x250: true, ARTICLE_END: false };
    const stored = stubSettings(t, { ...old, ...(value === undefined ? {} : { [SLOT]: value }) });
    const res = await auth(request(app).put('/api/admin/ad-settings')).send({ slotEnabled: old });
    const expected = { ...old, [SLOT]: value === true };
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, slotEnabled: expected });
    assert.deepEqual(stored(), expected);
    for (const enabled of [true, false]) {
      const changed = await auth(request(app).put('/api/admin/ad-settings'))
        .send({ slotEnabled: { [SLOT]: enabled } });
      assert.deepEqual(changed.body, { ok: true, slotEnabled: { ...old, [SLOT]: enabled } });
    }
  }
  const invalid = await auth(request(app).put('/api/admin/ad-settings'))
    .send({ slotEnabled: { [SLOT]: 'true' } });
  assert.equal(invalid.status, 400);
  const unauthenticated = await request(app).put('/api/admin/ad-settings')
    .send({ slotEnabled: { [SLOT]: true } });
  assert.equal(unauthenticated.status, 401);
});

for (const path of [`/api/public/ads?slot=${SLOT}`, `/api/public/ads/slot/${SLOT}`]) {
  test(`top-home missing/OFF, ON-empty and ON-ad response contracts: ${path}`, async (t) => {
    const ad = makeAd();
    for (const value of [undefined, false]) {
      stubSettings(t, { ...EXISTING_DEFAULTS, ...(value === undefined ? {} : { [SLOT]: value }) });
      const filters = stubPublicAds(t, [ad]);
      const res = await request(app).get(path);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: false, enabled: false, ad: null });
      assert.equal(filters.length, 0);
    }
    stubSettings(t, { ...EXISTING_DEFAULTS, [SLOT]: true });
    stubPublicAds(t, []);
    const empty = await request(app).get(path);
    assert.deepEqual(empty.body, { ok: false, enabled: true, ad: null });
    const filters = stubPublicAds(t, [ad]);
    const found = await request(app).get(path);
    assert.equal(found.status, 200);
    assert.deepEqual(Object.keys(found.body).sort(), ['ad', 'enabled', 'ok']);
    assert.equal(found.body.ok, true);
    assert.equal(found.body.enabled, true);
    assert.equal(found.body.ad.slot, SLOT);
    assert.deepEqual(Object.keys(found.body.ad).sort(), PUBLIC_AD_KEYS);
    assert.deepEqual(filters, [{ slot: { $in: [SLOT] }, isActive: true }]);
  });
}

test('every existing display slot and legacy rail alias remain independently servable', async (t) => {
  const allEnabled = Object.fromEntries(Object.keys(EXISTING_DEFAULTS).map((key) => [key, true]));
  stubSettings(t, { ...allEnabled, [SLOT]: true });
  const ads = Object.keys(allEnabled).filter((slot) => slot !== 'HOME_RIGHT_RAIL').map((slot) => makeAd(slot));
  ads.push(makeAd(SLOT, { priority: 999 }));
  stubPublicAds(t, ads);
  for (const slot of [...Object.keys(allEnabled), SLOT]) {
    const res = await request(app).get(`/api/public/ads?slot=${slot}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ad.slot, slot === 'HOME_RIGHT_RAIL' ? 'HOME_RIGHT_300x250' : slot);
  }
  // Other placements cannot fill an empty top-home premium slot.
  stubPublicAds(t, ads.filter((ad) => ad.slot !== SLOT));
  const empty = await request(app).get(`/api/public/ads?slot=${SLOT}`);
  assert.deepEqual(empty.body, { ok: false, enabled: true, ad: null });
  stubSettings(t, { ...allEnabled, [SLOT]: false });
  for (const slot of ['HOME_728x90', 'HOME_BILLBOARD_970x250']) {
    const res = await request(app).get(`/api/public/ads?slot=${slot}`);
    assert.equal(res.body.ad.slot, slot);
  }
});

test('top-home retains inclusive schedules, active filtering and descending priority/update order', async (t) => {
  const now = new Date('2026-10-01T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  stubSettings(t, { ...EXISTING_DEFAULTS, [SLOT]: true });
  for (const [schedule, eligible] of [
    [{ startAt: now, endAt: now }, true],
    [{ startAt: new Date(now.getTime() + 1) }, false],
    [{ endAt: new Date(now.getTime() - 1) }, false],
    [{ startAt: 'invalid' }, false],
    [{}, true],
  ]) {
    stubPublicAds(t, [makeAd(SLOT, schedule)]);
    const res = await request(app).get(`/api/public/ads?slot=${SLOT}`);
    assert.equal(res.body.ok, eligible);
    assert.equal(res.body.ad !== null, eligible);
  }
  const winner = makeAd(SLOT, { priority: 10, updatedAt: now });
  stubPublicAds(t, [
    makeAd(SLOT, { priority: 1 }),
    makeAd(SLOT, { priority: 100, isActive: false }),
    makeAd(SLOT, { priority: 99, startAt: new Date(now.getTime() + 1) }),
    makeAd(SLOT, { priority: 98, endAt: new Date(now.getTime() - 1) }),
    makeAd(SLOT, { priority: 10 }),
    winner,
  ]);
  const res = await request(app).get(`/api/public/ads/slot/${SLOT}`);
  assert.equal(res.body.ad.id, String(winner._id));
});

test('authenticated top-home create/list/update retains DTOs, defaults, counters and validation', async (t) => {
  let stored;
  t.mock.method(Ad, 'create', async (payload) => {
    const doc = new Ad(payload);
    assert.equal(doc.validateSync(), undefined);
    stored = doc.toObject();
    return stored;
  });
  t.mock.method(Ad, 'find', (filter) => {
    assert.deepEqual(filter, { slot: SLOT });
    return { sort() { return this; }, lean: async () => [stored] };
  });
  t.mock.method(Ad, 'findById', () => ({ lean: async () => stored }));
  t.mock.method(Ad, 'findByIdAndUpdate', async (_id, update) => {
    assert.equal(Object.hasOwn(update.$set, 'stats'), false);
    stored = { ...stored, ...update.$set };
    return stored;
  });
  const payload = {
    slot: SLOT, title: 'Premium', imageUrl: makeAd().imageUrl,
    targetUrl: 'https://example.test', stats: { impressions: 999, clicks: 999 },
  };
  assert.equal((await request(app).post('/api/admin/ads').send(payload)).status, 401);
  const created = await auth(request(app).post('/api/admin/ads')).send(payload);
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body.ad).sort(), ADMIN_AD_KEYS);
  assert.equal(created.body.ad.slot, SLOT);
  assert.equal(created.body.ad.isActive, false);
  assert.equal(created.body.ad.priority, 0);
  assert.equal(created.body.ad.startAt, null);
  assert.equal(created.body.ad.endAt, null);
  assert.deepEqual(created.body.ad.stats, { impressions: 0, clicks: 0 });
  const listed = await auth(request(app).get(`/api/admin/ads?slot=${SLOT}`));
  assert.deepEqual(listed.body, { ok: true, ads: [created.body.ad] });
  stored.stats = { impressions: 7, clicks: 2 };
  const updated = await auth(request(app).put(`/api/admin/ads/${created.body.ad.id}`)).send({
    ...payload, isActive: true, priority: 9,
    startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-31T00:00:00Z',
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(Object.keys(updated.body.ad).sort(), ADMIN_AD_KEYS);
  assert.equal(updated.body.ad.slot, SLOT);
  assert.equal(updated.body.ad.isActive, true);
  assert.equal(updated.body.ad.priority, 9);
  assert.equal(updated.body.ad.startAt, '2026-10-01T00:00:00.000Z');
  assert.equal(updated.body.ad.endAt, '2026-10-31T00:00:00.000Z');
  assert.deepEqual(updated.body.ad.stats, { impressions: 7, clicks: 2 });
  for (const invalid of [
    { slot: 'UNKNOWN' }, { imageUrl: 'bad' }, { isClickable: true, targetUrl: '' },
    { targetUrl: 'bad' }, { priority: 'bad' }, { startAt: 'bad' },
    { startAt: '2026-10-02', endAt: '2026-10-01' },
  ]) {
    for (const req of [
      request(app).post('/api/admin/ads'),
      request(app).put(`/api/admin/ads/${created.body.ad.id}`),
    ]) {
      const res = await auth(req).send({ ...payload, ...invalid });
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
    }
  }
});
