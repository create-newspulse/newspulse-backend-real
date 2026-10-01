process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'broadcast-ownership-isolated-test-secret';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const BroadcastSettings = require('../models/BroadcastSettings');
const BroadcastItem = require('../models/BroadcastItem');
const BroadcastVersion = require('../models/BroadcastVersion');
const PublicConfigVersion = require('../models/PublicConfigVersion');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const SiteSetting = require('../models/SiteSetting');
const User = require('../models/User');
const cache = require('../lib/cache');
const sse = require('../services/broadcastSse.service');
const { DEFAULT_TICKERS_CONFIG } = require('../schemas/tickersConfig.schema');
const { patchSettings, adminSettingsResponse } = require('../services/broadcastCenter.service');
const adminBroadcast = require('../routes/adminBroadcast.routes');
const tickerSettings = require('../routes/adminTickersSettings.routes');
const legacyBroadcast = require('../routes/broadcast.routes');
const publicBroadcast = require('../routes/publicBroadcast.routes');
const translatedBroadcast = require('../routes/publicApiBroadcast.routes');
const publicTickerSettings = require('../routes/publicTickersSettings.routes');

const app = express();
app.use(express.json());
app.use('/api/admin/broadcast', adminBroadcast);
app.use('/api/admin', tickerSettings);
app.use('/admin', tickerSettings);
app.use('/admin-api/admin', tickerSettings);
app.use('/admin-api/broadcast', legacyBroadcast);
app.use('/api/public/broadcast', publicBroadcast);
app.use('/public-api/broadcast', translatedBroadcast);
app.use('/api/public', publicTickerSettings);

const copy = (value) => JSON.parse(JSON.stringify(value));
let stored;
let version = 100;
let saves;
let invalidations;
let publicVersionWrites;
let notifications;
let itemFilters;

function initialSettings() {
  return {
    breaking: { enabled: true, mode: 'force_on', tickerSpeedSeconds: 20, speedSec: 20, maxItems: 7 },
    live: { enabled: false, mode: 'auto', tickerSpeedSeconds: 24, speedSec: 24, maxItems: 17 },
    pauseOnHover: false,
    breakingEnabled: true, liveEnabled: false,
    breakingMode: 'auto', liveMode: 'auto',
    breakingDurationSeconds: 20, liveDurationSeconds: 24,
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

function auth(req) {
  const token = jwt.sign({
    sub: '507f1f77bcf86cd799439101', role: 'founder', type: 'access', tokenVersion: 0,
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`);
}

async function flushNotifications() {
  await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach((t) => {
  stored = initialSettings();
  saves = 0;
  publicVersionWrites = 0;
  itemFilters = [];
  version += 100;
  const readyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = readyState; });
  t.mock.method(User, 'findById', () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439101', role: 'founder', status: 'active', noExpiry: true, tokenVersion: 0,
  }) }));
  t.mock.method(BroadcastSettings, 'findOne', async () => ({
    ...copy(stored),
    async save() {
      assert.equal(new BroadcastSettings(this.toObject()).validateSync(), undefined);
      saves += 1;
      stored = this.toObject();
      return this;
    },
    toObject() {
      const { save, toObject, ...data } = this;
      return copy(data);
    },
  }));
  t.mock.method(BroadcastSettings, 'findOneAndUpdate', () => {
    throw new Error('Configuration must use canonical patch/save, not replacement updates');
  });
  t.mock.method(BroadcastVersion, 'findOne', () => ({ lean: async () => ({ key: 'global', version }) }));
  t.mock.method(BroadcastVersion, 'findOneAndUpdate', () => ({ lean: async () => ({ version: ++version }) }));
  t.mock.method(PublicConfigVersion, 'findOne', () => ({ lean: async () => ({ version: 1 }) }));
  t.mock.method(PublicConfigVersion, 'findOneAndUpdate', () => ({
    lean: async () => { publicVersionWrites += 1; return { version: 2 }; },
  }));
  invalidations = t.mock.method(cache, 'invalidateBroadcastCaches', async () => {});
  notifications = t.mock.method(sse, 'emitBroadcastUpdated');
  t.mock.method(BroadcastItem, 'find', (filter) => {
    itemFilters.push(filter);
    return {
      sort(order) { assert.deepEqual(order, { createdAt: -1 }); return this; },
      limit(limit) { assert.equal(limit, 50); return this; },
      lean: async () => Array.from({ length: 25 }, (_, index) => ({
        _id: `${filter.type}-${index}`, type: filter.type, isLive: true,
        text: `Item ${index}`, lang: 'en', sourceLang: 'en',
        text_i18n: { en: `Item ${index}`, hi: `Item ${index}`, gu: `Item ${index}` },
        createdAt: new Date(), expiresAt: null,
      })),
    };
  });
  for (const Model of [PublicSiteSettings, SiteSetting]) {
    for (const method of ['findOne', 'findOneAndUpdate', 'create', 'updateOne']) {
      t.mock.method(Model, method, () => { throw new Error('Editorial config must not access another settings store'); });
    }
  }
});

function assertOneSavedNotification(beforeVersion) {
  assert.equal(saves, 1);
  assert.equal(notifications.mock.callCount(), 1);
  assert.equal(invalidations.mock.callCount(), 1);
  assert.equal(publicVersionWrites, 1);
  assert.equal(version, beforeVersion + 1);
}

test('Broadcast ownership: canonical route partial updates preserve unrelated fields and mirrors', async () => {
  for (const channel of ['breaking', 'live']) {
    for (const patch of [{ tickerSpeedSeconds: 26 }, { enabled: true }, { mode: 'force_off' }, { maxItems: 2 }]) {
      const before = copy(stored);
      const res = await auth(request(app).patch(`/api/admin/broadcast/config/${channel}`)).send(patch);
      assert.equal(res.status, 200);
      await flushNotifications();
      const expected = { ...before[channel], ...patch };
      if (patch.tickerSpeedSeconds) expected.speedSec = patch.tickerSpeedSeconds;
      assert.deepEqual(stored[channel], expected);
      const other = channel === 'breaking' ? 'live' : 'breaking';
      assert.deepEqual(stored[other], before[other]);
      assert.equal(stored.pauseOnHover, false);
      assert.equal(stored[`${channel}Enabled`], expected.enabled);
      assert.equal(stored[`${channel}DurationSeconds`], expected.tickerSpeedSeconds);
    }
  }
});

test('Broadcast ownership: all canonical duration entry points prefer tickerSpeedSeconds', async () => {
  const conflict = {
    tickerSpeedSeconds: 23, speedSec: 12, speedSeconds: 13,
    durationSec: 14, durationSeconds: 15, scrollDurationSeconds: 16, scrollDurationSec: 17,
  };
  for (const [path, payload] of [
    ['/api/admin/broadcast', { breaking: conflict }],
    ['/api/admin/broadcast', conflict],
    ['/api/admin/broadcast', { breakingTickerSpeedSeconds: 23, breakingDurationSeconds: 15 }],
    ['/api/admin/broadcast/config', { breaking: conflict }],
    ['/api/admin/broadcast/config/breaking', conflict],
    ['/admin-api/broadcast/settings', { breaking: conflict }],
  ]) {
    const res = await auth(request(app).patch(path)).send(payload);
    assert.equal(res.status, 200);
    await flushNotifications();
    assert.equal(stored.breaking.tickerSpeedSeconds, 23, path);
    assert.equal(stored.breaking.speedSec, 23, path);
    assert.equal(stored.breakingDurationSeconds, 23, path);
  }
});

for (const path of [
  '/api/admin/public-settings/tickers/draft',
  '/api/admin/public-settings/tickers?status=draft',
  '/admin-api/admin/tickers/draft',
]) {
  test(`Broadcast ownership: legacy partial duration saves preserve newer fields and invalidate snapshots: ${path}`, async () => {
    const before = copy(stored);
    const beforeVersion = version;
    const oldSnapshot = await sse.buildBroadcastSnapshot({ lang: 'en' });
    const res = await auth(request(app).put(path)).send({ tickers: { breaking: { speedSec: 28 } } });
    assert.equal(res.status, 200);
    await flushNotifications();
    assertOneSavedNotification(beforeVersion);
    assert.deepEqual(stored.breaking, { ...before.breaking, tickerSpeedSeconds: 28, speedSec: 28 });
    assert.deepEqual(stored.live, before.live);
    assert.equal(stored.pauseOnHover, false);
    assert.equal(stored.breakingDurationSeconds, 28);
    assert.equal(res.body.source, 'broadcast');
    assert.equal(res.body.setting.status, 'draft');
    assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'setting', 'source', 'status', 'success']);
    assert.deepEqual(Object.keys(res.body.setting.data.tickers).sort(), ['breaking', 'live', 'pauseOnHover']);
    assert.equal(res.body.setting.data.tickers.breaking.speedSec, 28);
    assert.equal(res.body.setting.data.tickers.live.maxItems, 17);
    const snapshot = await sse.buildBroadcastSnapshot({ lang: 'en' });
    assert.equal(oldSnapshot.breaking.durationSeconds, 20);
    assert.equal(snapshot.breaking.durationSeconds, 28);
    assert.equal(snapshot.version, beforeVersion + 1);
  });
}

test('Broadcast ownership: compatibility toggles retain approved legacy coupling without resetting duration/limits', async () => {
  const path = '/api/admin/tickers/draft';
  for (const mode of ['off', 'force_on', 'auto']) {
    const res = await auth(request(app).put(path)).send({ tickers: { breaking: { mode } } });
    assert.equal(res.status, 200);
    await flushNotifications();
    assert.equal(stored.breaking.enabled, mode !== 'off');
    assert.equal(stored.breaking.mode, mode === 'off' ? 'force_off' : mode);
    assert.equal(res.body.setting.data.tickers.breaking.mode, mode);
    assert.equal(stored.breaking.tickerSpeedSeconds, 20);
    assert.equal(stored.breaking.maxItems, 7);
  }
  for (const enabled of [true, false]) {
    const res = await auth(request(app).put(path)).send({ tickers: { live: { enabled } } });
    assert.equal(res.status, 200);
    await flushNotifications();
    assert.equal(stored.live.mode, enabled ? 'auto' : 'force_off');
    assert.equal(stored.live.enabled, enabled);
    assert.equal(stored.live.tickerSpeedSeconds, 24);
    assert.equal(stored.live.maxItems, 17);
    assert.equal(stored.pauseOnHover, false);
  }
  const res = await auth(request(app).put(path)).send({ tickers: { live: { maxItems: 4 }, pauseOnHover: true } });
  assert.equal(res.status, 200);
  await flushNotifications();
  assert.equal(stored.live.mode, 'force_off');
  assert.equal(stored.live.enabled, false);
  assert.equal(stored.live.tickerSpeedSeconds, 24);
  assert.equal(stored.live.maxItems, 4);
  assert.equal(stored.pauseOnHover, true);
});

test('Broadcast ownership: full legacy payload keeps its envelope and clamps through canonical service', async () => {
  const config = copy(DEFAULT_TICKERS_CONFIG);
  config.tickers.breaking.speedSec = 100;
  const beforeVersion = version;
  const res = await auth(request(app).put('/api/admin/tickers/draft')).send(config);
  assert.equal(res.status, 200);
  await flushNotifications();
  assertOneSavedNotification(beforeVersion);
  assert.equal(res.body.setting.data.tickers.breaking.speedSec, 30);
  assert.equal(res.body.setting.data.tickers.live.speedSec, 24);
  assert.deepEqual(Object.keys(res.body.setting.data.tickers.live).sort(),
    ['enabled', 'maxItems', 'placeholder', 'refreshSec', 'showOn', 'speedSec']);
  assert.deepEqual(Object.keys(res.body.setting.data.tickers.breaking).sort(),
    ['freshnessMinutes', 'maxItems', 'mode', 'placeholder', 'showWhenEmpty', 'speedSec']);
});

test('Broadcast ownership: ticker compatibility validation does not strip conflicting canonical input', async () => {
  const res = await auth(request(app).put('/api/admin/tickers/draft')).send({
    tickers: {
      breaking: { tickerSpeedSeconds: 26, speedSec: 20 },
      live: { tickerSpeedSeconds: 27, speedSec: 21 },
    },
  });
  assert.equal(res.status, 200);
  await flushNotifications();
  assert.equal(stored.breaking.tickerSpeedSeconds, 26);
  assert.equal(stored.live.tickerSpeedSeconds, 27);
  assert.equal(res.body.setting.data.tickers.breaking.speedSec, 26);
  assert.equal(res.body.setting.data.tickers.live.speedSec, 27);
  assert.equal(stored.live.enabled, false);
  assert.equal(stored.live.mode, 'auto');
});

for (const [method, path, payload] of [
  ['put', '/api/admin/broadcast/config', { breaking: { maxItems: 3 }, live: { maxItems: 4 }, pauseOnHover: true }],
  ['put', '/api/admin/broadcast', { breaking: { maxItems: 3 }, pauseOnHover: true }],
  ['post', '/api/admin/broadcast', { live: { maxItems: 4 }, pauseOnHover: true }],
  ['patch', '/api/admin/broadcast/settings', { pauseOnHover: true }],
]) {
  test(`Broadcast ownership: ${method.toUpperCase()} ${path} saves and notifies exactly once`, async () => {
    const beforeVersion = version;
    const res = await auth(request(app)[method](path)).send(payload);
    assert.equal(res.status, 200);
    await flushNotifications();
    assertOneSavedNotification(beforeVersion);
    assert.equal(stored.pauseOnHover, true);
    assert.equal(stored.breaking.tickerSpeedSeconds, 20);
    assert.equal(stored.live.tickerSpeedSeconds, 24);
    assert.equal(stored.breaking.mode, 'force_on');
    assert.equal(stored.live.mode, 'auto');
    assert.equal(stored.live.enabled, false);
    if (payload.breaking) assert.equal(stored.breaking.maxItems, 3);
    if (payload.live) assert.equal(stored.live.maxItems, 4);
  });
}

test('Broadcast ownership: older Broadcast config writers notify once and preserve missing fields', async () => {
  const beforeVersion = version;
  const res = await auth(request(app).patch('/admin-api/broadcast/settings')).send({ live: { durationSeconds: 26 } });
  assert.equal(res.status, 200);
  await flushNotifications();
  assertOneSavedNotification(beforeVersion);
  assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'settings']);
  assert.equal(res.body.settings.live.durationSeconds, 26);
  assert.equal(stored.live.enabled, false);
  assert.equal(stored.live.mode, 'auto');
  assert.equal(stored.live.maxItems, 17);
});

test('Broadcast ownership: legacy flat settings PUT delegates to canonical storage and keeps response shape', async () => {
  const beforeVersion = version;
  const res = await auth(request(app).put('/admin-api/broadcast/settings')).send({ liveEnabled: true });
  assert.equal(res.status, 200);
  await flushNotifications();
  assertOneSavedNotification(beforeVersion);
  assert.deepEqual(Object.keys(res.body).sort(),
    ['breakingEnabled', 'breakingMode', 'liveEnabled', 'liveMode', 'updatedAt']);
  assert.equal(stored.live.enabled, true);
  assert.equal(stored.live.mode, 'auto');
  assert.equal(stored.live.tickerSpeedSeconds, 24);
  assert.equal(stored.live.maxItems, 17);
});

test('Broadcast ownership: public config/settings/content shapes and query limits remain unchanged', async () => {
  stored.breaking.maxItems = 2;
  const config = await request(app).get('/api/public/broadcast/config');
  assert.equal(config.status, 200);
  assert.deepEqual(Object.keys(config.body).sort(),
    ['breaking', 'breakingMaxItems', 'breakingSpeedSec', 'live', 'liveMaxItems', 'liveSpeedSec', 'pauseOnHover', 'version']);
  assert.equal(config.body.breakingSpeedSec, 20);
  assert.equal(config.body.liveSpeedSec, 24);
  assert.equal(config.body.breakingMaxItems, 2);
  assert.equal(config.body.pauseOnHover, false);
  const settings = await request(app).get('/api/public/broadcast/settings');
  assert.deepEqual(settings.body, { ok: true, version, settings: adminSettingsResponse(stored) });
  const plain = await request(app).get('/api/public/broadcast');
  assert.equal(plain.body.breaking.items.length, 25);
  assert.equal(plain.body.breaking.durationSec, 20);
  const localized = await request(app).get('/api/public/broadcast?lang=en');
  assert.deepEqual(Object.keys(localized.body).sort(), ['breaking', 'live']);
  assert.equal(localized.body.breaking.items.length, 20);
  assert.equal(localized.body.live.enabled, false);
  const translated = await request(app).get('/public-api/broadcast?lang=en&nocache=1');
  assert.equal(translated.status, 200);
  assert.equal(translated.body.breaking.durationSec, 20);
  assert.equal(translated.body.breaking.items.length, 25);
  assert.ok(itemFilters.every((filter) => filter.isLive === true && filter.createdAt.$gte instanceof Date && Array.isArray(filter.$or)));
  assert.equal(saves, 0);
});

test('Broadcast ownership: unauthenticated and invalid writes never save or notify', async () => {
  const before = copy(stored);
  for (const [method, path, body] of [
    ['patch', '/api/admin/broadcast/config', { breaking: { enabled: true } }],
    ['put', '/api/admin/tickers/draft', { tickers: { live: { enabled: true } } }],
    ['patch', '/admin-api/broadcast/settings', { live: { enabled: true } }],
  ]) {
    const res = await request(app)[method](path).send(body);
    assert.equal(res.status, 401);
  }
  const invalid = await auth(request(app).patch('/api/admin/broadcast/config'))
    .send({ breaking: { tickerSpeedSeconds: 'invalid', speedSec: 20 } });
  assert.equal(invalid.status, 400);
  const invalidCompat = await auth(request(app).put('/api/admin/tickers/draft'))
    .send({ tickers: { live: { enabled: 'yes' } } });
  assert.equal(invalidCompat.status, 400);
  assert.equal(saves, 0);
  assert.equal(notifications.mock.callCount(), 0);
  assert.deepEqual(stored, before);
});

test('Broadcast ownership: SiteSetting draft/publish and public ticker paths retain their own store', async (t) => {
  let draft = null;
  let published = null;
  t.mock.method(SiteSetting, 'findOne', (filter) => {
    const value = filter.status === 'draft' ? draft : published;
    const query = Promise.resolve(value);
    query.sort = () => query;
    return query;
  });
  t.mock.method(SiteSetting, 'findOneAndUpdate', async (_filter, update) => {
    draft = update.$set;
    return draft;
  });
  t.mock.method(SiteSetting, 'create', async (payload) => { published = payload; return payload; });
  const config = copy(DEFAULT_TICKERS_CONFIG);
  config.tickers.breaking.speedSec = 100;
  const saved = await auth(request(app).put('/admin/settings/tickers/draft')).send(config);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.setting.data.tickers.breaking.speedSec, 100);
  const pub = await auth(request(app).post('/admin/settings/tickers/publish')).send({});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.setting.version, 1);
  const read = await request(app).get('/api/public/settings/tickers');
  assert.equal(read.body.source, 'published');
  assert.equal(read.body.data.tickers.breaking.speedSec, 100);
  assert.equal(saves, 0);
  assert.equal(notifications.mock.callCount(), 0);
  assert.deepEqual(stored, initialSettings());
});

test('Broadcast ownership: notification failures are reported without undoing saved configuration', async (t) => {
  t.mock.method(sse, 'emitBroadcastUpdated', async () => { throw new Error('test notification failure'); });
  const warnings = t.mock.method(console, 'warn', () => {});
  const result = await patchSettings({ pauseOnHover: true });
  await flushNotifications();
  assert.equal(result.ok, true);
  assert.equal(stored.pauseOnHover, true);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === '[broadcast][config] update notification failed'));
  assert.equal(invalidations.mock.callCount(), 1);
});

test('Broadcast ownership: failed persistence does not publish a successful update', async (t) => {
  const findOne = BroadcastSettings.findOne;
  t.mock.method(BroadcastSettings, 'findOne', async () => {
    const doc = await findOne();
    doc.save = async () => { throw new Error('isolated save failure'); };
    return doc;
  });
  await assert.rejects(patchSettings({ pauseOnHover: true }), /isolated save failure/);
  await flushNotifications();
  assert.equal(stored.pauseOnHover, false);
  assert.equal(notifications.mock.callCount(), 0);
  assert.equal(invalidations.mock.callCount(), 0);
  assert.equal(publicVersionWrites, 0);
});
