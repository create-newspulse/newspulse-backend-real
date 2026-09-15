process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ad-performance-daily-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const analyticsRouter = require('../routes/adminAnalytics.routes');
const publicAdsRouter = require('../routes/publicAds.routes');
const Ad = require('../models/Ad');
const AdPerformanceDaily = require('../models/AdPerformanceDaily');
const { incrementDailyAdPerformance } = require('../controllers/publicAdsController');

function publicApp() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/public', publicAdsRouter);
  return instance;
}

function analyticsApp() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/admin/analytics', analyticsRouter);
  return instance;
}

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function auth(req) {
  return req.set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);
}

function stubReadyState(t, readyState = 1) {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = readyState;
  t.after(() => { mongoose.connection.readyState = previous; });
}

function stubMethod(t, object, key, value) {
  const previous = object[key];
  object[key] = value;
  t.after(() => { object[key] = previous; });
}

function utcDayOffset(offset) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function installDailyUpdateStore(t) {
  const rows = new Map();
  const calls = [];

  stubMethod(t, AdPerformanceDaily, 'updateOne', async (filter, update, options = {}) => {
    calls.push({ filter, update, options });
    const key = `${String(filter.adId)}:${filter.dateKey}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        adId: filter.adId,
        dateKey: filter.dateKey,
        slot: update.$set?.slot,
        impressions: 0,
        clicks: 0,
      };
      rows.set(key, row);
    }
    if (update.$set) Object.assign(row, update.$set);
    if (update.$inc) {
      for (const [field, value] of Object.entries(update.$inc)) {
        row[field] = Number(row[field] || 0) + Number(value || 0);
      }
    }
    return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: 1 };
  });

  return { rows, calls };
}

function filterDailyRows(docs, match = {}) {
  const dateMatch = match.dateKey || {};
  return docs.filter((doc) => {
    if (dateMatch.$gte && doc.dateKey < dateMatch.$gte) return false;
    if (dateMatch.$lte && doc.dateKey > dateMatch.$lte) return false;
    return true;
  });
}

function stubDailyFind(t, docs, capture) {
  stubMethod(t, AdPerformanceDaily, 'find', (match = {}) => {
    if (capture) capture(match);
    return { lean: async () => filterDailyRows(docs, match) };
  });
}

function stubAdFind(t, docs) {
  stubMethod(t, Ad, 'find', (filter = {}) => ({
    select: () => ({
      lean: async () => {
        const ids = new Set(((filter._id && filter._id.$in) || []).map((id) => String(id)));
        return docs.filter((doc) => ids.has(String(doc._id)));
      },
    }),
  }));
}

function stubLifetimeAggregate(t, docs) {
  stubMethod(t, Ad, 'aggregate', async () => [{
    _id: null,
    impressions: docs.reduce((sum, doc) => sum + Number(doc.stats?.impressions || 0), 0),
    clicks: docs.reduce((sum, doc) => sum + Number(doc.stats?.clicks || 0), 0),
    totalAds: docs.length,
    activeAds: docs.filter((doc) => doc.isActive === true).length,
  }]);
}

test('public impression preserves lifetime counter and increments daily aggregate', async (t) => {
  stubReadyState(t, 1);
  const adId = new mongoose.Types.ObjectId();
  const daily = installDailyUpdateStore(t);
  let lifetimeImpressions = 0;

  stubMethod(t, Ad, 'findByIdAndUpdate', async (_id, update, options) => {
    assert.equal(String(_id), String(adId));
    assert.deepEqual(update, { $inc: { 'stats.impressions': 1 } });
    assert.deepEqual(options.projection, { _id: 1, slot: 1 });
    lifetimeImpressions += 1;
    return { _id: adId, slot: 'ARTICLE_INLINE' };
  });

  const res = await request(publicApp()).post(`/api/public/ads/${adId}/impression`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(lifetimeImpressions, 1);
  assert.equal(daily.calls.length, 1);
  const row = Array.from(daily.rows.values())[0];
  assert.equal(row.dateKey, new Date().toISOString().slice(0, 10));
  assert.equal(row.slot, 'ARTICLE_INLINE');
  assert.equal(row.impressions, 1);
  assert.equal(row.clicks, 0);
});

test('public click preserves lifetime counter and increments daily aggregate', async (t) => {
  stubReadyState(t, 1);
  const adId = new mongoose.Types.ObjectId();
  const daily = installDailyUpdateStore(t);
  let lifetimeClicks = 0;

  stubMethod(t, Ad, 'findById', () => ({
    select: (selection) => {
      assert.deepEqual(selection, { isClickable: 1, slot: 1 });
      return { lean: async () => ({ _id: adId, isClickable: true, slot: 'HOME_728x90' }) };
    },
  }));
  stubMethod(t, Ad, 'updateOne', async (filter, update) => {
    assert.equal(String(filter._id), String(adId));
    assert.deepEqual(update, { $inc: { 'stats.clicks': 1 } });
    lifetimeClicks += 1;
  });

  const res = await request(publicApp()).post(`/api/public/ads/${adId}/click`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(lifetimeClicks, 1);
  assert.equal(daily.calls.length, 1);
  const row = Array.from(daily.rows.values())[0];
  assert.equal(row.slot, 'HOME_728x90');
  assert.equal(row.clicks, 1);
  assert.equal(row.impressions, 0);
});

test('same-day impressions and clicks aggregate into one daily row', async (t) => {
  const adId = new mongoose.Types.ObjectId();
  const daily = installDailyUpdateStore(t);
  const ad = { _id: adId, slot: 'ARTICLE_INLINE' };
  const now = new Date('2026-09-16T12:00:00.000Z');

  await incrementDailyAdPerformance(ad, 'impressions', now);
  await incrementDailyAdPerformance(ad, 'impressions', now);
  await incrementDailyAdPerformance(ad, 'clicks', now);
  await incrementDailyAdPerformance(ad, 'clicks', now);
  await incrementDailyAdPerformance(ad, 'clicks', now);

  assert.equal(daily.rows.size, 1);
  const row = Array.from(daily.rows.values())[0];
  assert.equal(row.dateKey, '2026-09-16');
  assert.equal(row.impressions, 2);
  assert.equal(row.clicks, 3);
  assert.equal(daily.calls.every((call) => call.options.upsert === true), true);
});

test('next UTC day creates a separate daily row', async (t) => {
  const adId = new mongoose.Types.ObjectId();
  const daily = installDailyUpdateStore(t);
  const ad = { _id: adId, slot: 'ARTICLE_INLINE' };

  await incrementDailyAdPerformance(ad, 'impressions', new Date('2026-09-16T23:59:59.000Z'));
  await incrementDailyAdPerformance(ad, 'impressions', new Date('2026-09-17T00:00:00.000Z'));

  assert.equal(daily.rows.size, 2);
  assert.equal(daily.rows.get(`${String(adId)}:2026-09-16`).impressions, 1);
  assert.equal(daily.rows.get(`${String(adId)}:2026-09-17`).impressions, 1);
});

test('daily upserts use one atomic adId/dateKey filter under concurrent calls', async (t) => {
  const adId = new mongoose.Types.ObjectId();
  const daily = installDailyUpdateStore(t);
  const ad = { _id: adId, slot: 'ARTICLE_INLINE' };
  const now = new Date('2026-09-16T08:00:00.000Z');

  await Promise.all(Array.from({ length: 20 }, () => incrementDailyAdPerformance(ad, 'impressions', now)));

  assert.equal(daily.rows.size, 1);
  assert.equal(Array.from(daily.rows.values())[0].impressions, 20);
  assert.equal(daily.calls.length, 20);
  for (const call of daily.calls) {
    assert.equal(String(call.filter.adId), String(adId));
    assert.equal(call.filter.dateKey, '2026-09-16');
    assert.equal(call.options.upsert, true);
    assert.deepEqual(call.update.$inc, { impressions: 1 });
  }
});

test('daily analytics failure does not break public impression response after lifetime success', async (t) => {
  stubReadyState(t, 1);
  const adId = new mongoose.Types.ObjectId();
  let lifetimeImpressions = 0;
  const warnings = [];

  stubMethod(t, Ad, 'findByIdAndUpdate', async () => {
    lifetimeImpressions += 1;
    return { _id: adId, slot: 'ARTICLE_INLINE' };
  });
  stubMethod(t, AdPerformanceDaily, 'updateOne', async () => { throw new Error('daily failure with internals'); });
  stubMethod(t, console, 'warn', (...args) => { warnings.push(args); });

  const res = await request(publicApp()).post(`/api/public/ads/${adId}/impression`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(lifetimeImpressions, 1);
  assert.equal(warnings.length, 1);
  assert.equal(String(warnings[0].join(' ')).includes('internals'), false);
});

test('daily analytics failure does not break public click response after lifetime success', async (t) => {
  stubReadyState(t, 1);
  const adId = new mongoose.Types.ObjectId();
  let lifetimeClicks = 0;
  const warnings = [];

  stubMethod(t, Ad, 'findById', () => ({
    select: () => ({ lean: async () => ({ _id: adId, isClickable: true, slot: 'ARTICLE_INLINE' }) }),
  }));
  stubMethod(t, Ad, 'updateOne', async () => { lifetimeClicks += 1; });
  stubMethod(t, AdPerformanceDaily, 'updateOne', async () => { throw new Error('daily failure with internals'); });
  stubMethod(t, console, 'warn', (...args) => { warnings.push(args); });

  const res = await request(publicApp()).post(`/api/public/ads/${adId}/click`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(lifetimeClicks, 1);
  assert.equal(warnings.length, 1);
  assert.equal(String(warnings[0].join(' ')).includes('internals'), false);
});

test('ad performance without date filter keeps the lifetime response contract', async (t) => {
  stubReadyState(t, 1);
  stubLifetimeAggregate(t, [
    { isActive: true, stats: { impressions: 100, clicks: 5 } },
    { isActive: false, stats: { impressions: 50, clicks: 10 } },
  ]);
  stubMethod(t, AdPerformanceDaily, 'find', () => { throw new Error('daily rows must not be read for lifetime'); });

  const res = await auth(request(analyticsApp()).get('/api/admin/analytics/ad-performance'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.scope, 'lifetime');
  assert.equal(res.body.dateRangeSupported, false);
  assert.deepEqual(res.body.metrics, {
    impressions: 150,
    clicks: 15,
    ctr: 10,
    totalAds: 2,
    activeAds: 1,
  });
});

test('last7d and last30d historical totals use daily rows only', async (t) => {
  stubReadyState(t, 1);
  const adId = new mongoose.Types.ObjectId();
  stubDailyFind(t, [
    { adId, dateKey: utcDayOffset(-29), slot: 'ARTICLE_INLINE', impressions: 30, clicks: 3 },
    { adId, dateKey: utcDayOffset(-6), slot: 'ARTICLE_INLINE', impressions: 7, clicks: 1 },
    { adId, dateKey: utcDayOffset(-1), slot: 'ARTICLE_INLINE', impressions: 10, clicks: 1 },
    { adId, dateKey: utcDayOffset(-30), slot: 'ARTICLE_INLINE', impressions: 999, clicks: 99 },
  ]);
  stubAdFind(t, [{ _id: adId, title: 'Public Title', slot: 'ARTICLE_INLINE', isActive: true }]);
  stubMethod(t, Ad, 'aggregate', async () => { throw new Error('lifetime aggregate must not be used for history'); });

  const last7d = await auth(request(analyticsApp()).get('/api/admin/analytics/ad-performance?dateRange=last7d'));
  const last30d = await auth(request(analyticsApp()).get('/api/admin/analytics/ad-performance?dateRange=last30d'));

  assert.equal(last7d.statusCode, 200);
  assert.equal(last7d.body.scope, 'last7d');
  assert.equal(last7d.body.dateRangeSupported, true);
  assert.equal(last7d.body.metrics.impressions, 17);
  assert.equal(last7d.body.metrics.clicks, 2);
  assert.equal(last30d.statusCode, 200);
  assert.equal(last30d.body.scope, 'last30d');
  assert.equal(last30d.body.metrics.impressions, 47);
  assert.equal(last30d.body.metrics.clicks, 5);
});

test('custom historical range, CTR, daily trend, per-ad, placement, and top ads are derived from daily rows', async (t) => {
  stubReadyState(t, 1);
  const ad1 = new mongoose.Types.ObjectId();
  const ad2 = new mongoose.Types.ObjectId();
  const ad3 = new mongoose.Types.ObjectId();

  stubDailyFind(t, [
    { adId: ad1, dateKey: '2026-09-10', slot: 'ARTICLE_INLINE', impressions: 100, clicks: 5 },
    { adId: ad1, dateKey: '2026-09-11', slot: 'ARTICLE_INLINE', impressions: 50, clicks: 5 },
    { adId: ad2, dateKey: '2026-09-11', slot: 'HOME_728x90', impressions: 10, clicks: 0 },
    { adId: ad3, dateKey: '2026-09-12', slot: 'HOME_728x90', impressions: 0, clicks: 2 },
    { adId: ad1, dateKey: '2026-08-31', slot: 'ARTICLE_INLINE', impressions: 999, clicks: 99 },
  ]);
  stubAdFind(t, [
    { _id: ad1, title: 'Launch Sponsor', slot: 'ARTICLE_INLINE', isActive: true, targetUrl: 'https://private.example/a', createdBy: 'private-user' },
    { _id: ad2, title: 'Header Sponsor', slot: 'HOME_728x90', isActive: false, advertiserEmail: 'private@example.com' },
    { _id: ad3, title: 'Zero Impression Sponsor', slot: 'HOME_728x90', isActive: true, sponsorName: 'Private Sponsor' },
  ]);
  stubMethod(t, Ad, 'aggregate', async () => { throw new Error('lifetime aggregate must not be used for history'); });

  const res = await auth(request(analyticsApp()).get('/api/admin/analytics/ad-performance?dateFrom=2026-09-10&dateTo=2026-09-12'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, 'custom');
  assert.equal(res.body.dateGranularity, 'day');
  assert.equal(res.body.metrics.impressions, 160);
  assert.equal(res.body.metrics.clicks, 12);
  assert.equal(res.body.metrics.ctr, 7.5);
  assert.equal(res.body.metrics.adsWithActivity, 3);
  assert.equal(res.body.metrics.activeAds, 2);
  assert.deepEqual(res.body.dailyTrend.map((row) => ({ date: row.date, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr })), [
    { date: '2026-09-10', impressions: 100, clicks: 5, ctr: 5 },
    { date: '2026-09-11', impressions: 60, clicks: 5, ctr: 8.3333 },
    { date: '2026-09-12', impressions: 0, clicks: 2, ctr: 0 },
  ]);
  assert.deepEqual(res.body.perAd.map((row) => ({ adId: row.adId, title: row.title, slot: row.slot, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr })), [
    { adId: String(ad1), title: 'Launch Sponsor', slot: 'ARTICLE_INLINE', impressions: 150, clicks: 10, ctr: 6.6667 },
    { adId: String(ad2), title: 'Header Sponsor', slot: 'HOME_728x90', impressions: 10, clicks: 0, ctr: 0 },
    { adId: String(ad3), title: 'Zero Impression Sponsor', slot: 'HOME_728x90', impressions: 0, clicks: 2, ctr: 0 },
  ]);
  assert.deepEqual(res.body.placements, [
    { slot: 'ARTICLE_INLINE', impressions: 150, clicks: 10, ctr: 6.6667, adsWithActivity: 1 },
    { slot: 'HOME_728x90', impressions: 10, clicks: 2, ctr: 20, adsWithActivity: 2 },
  ]);
  assert.equal(res.body.topAds.byImpressions[0].adId, String(ad1));
  assert.equal(res.body.topAds.byClicks[0].adId, String(ad1));
  assert.equal(res.body.topAds.byCtr[0].adId, String(ad1));

  const raw = JSON.stringify(res.body);
  for (const privateValue of ['targetUrl', 'createdBy', 'private-user', 'advertiserEmail', 'private@example.com', 'sponsorName', 'Private Sponsor']) {
    assert.equal(raw.includes(privateValue), false);
  }
});

test('historical ad performance does not backfill pre-launch lifetime counters', async (t) => {
  stubReadyState(t, 1);
  stubDailyFind(t, []);
  stubAdFind(t, []);
  stubMethod(t, Ad, 'aggregate', async () => [{
    _id: null,
    impressions: 5000,
    clicks: 250,
    totalAds: 4,
    activeAds: 3,
  }]);

  const res = await auth(request(analyticsApp()).get('/api/admin/analytics/ad-performance?dateFrom=2026-09-01&dateTo=2026-09-30'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, 'custom');
  assert.equal(res.body.metrics.impressions, 0);
  assert.equal(res.body.metrics.clicks, 0);
  assert.equal(res.body.metrics.ctr, 0);
  assert.deepEqual(res.body.dailyTrend, []);
  assert.deepEqual(res.body.perAd, []);
  assert.deepEqual(res.body.placements, []);
});