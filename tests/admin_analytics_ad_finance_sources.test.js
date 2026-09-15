process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-analytics-source-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const analyticsRouter = require('../routes/adminAnalytics.routes');
const adminAdsRouter = require('../routes/adminAds.routes');
const financeRouter = require('../routes/finance.routes');
const Ad = require('../models/Ad');
const AdPerformanceDaily = require('../models/AdPerformanceDaily');
const FinanceRecord = require('../models/FinanceRecord');

function app() {
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

function adAggregateFromDocs(docs) {
  return async () => {
    if (!docs.length) return [];
    return [{
      _id: null,
      impressions: docs.reduce((sum, doc) => sum + Number(doc.stats?.impressions || 0), 0),
      clicks: docs.reduce((sum, doc) => sum + Number(doc.stats?.clicks || 0), 0),
      totalAds: docs.length,
      activeAds: docs.filter((doc) => doc.isActive === true).length,
    }];
  };
}

const PAID_STATUSES = new Set(['paid', 'received', 'completed', 'settled']);
const CLOSED_UNPAID_STATUSES = new Set(['cancelled', 'canceled', 'void', 'written_off', 'written off']);

function effectiveFinanceDate(doc) {
  if (doc.paidAt) return doc.paidAt;
  if (doc.type === 'invoice') return doc.dueDate || doc.createdAt || null;
  return doc.createdAt || null;
}

function financeAggregateFromDocs(docs, capturePipeline) {
  return async (pipeline) => {
    if (capturePipeline) capturePipeline(pipeline);
    const match = pipeline.find((stage) => stage && stage.$match && stage.$match.analyticsDate)?.$match?.analyticsDate || {};
    const filtered = docs.filter((doc) => {
      const date = effectiveFinanceDate(doc);
      if (!date) return !match.$gte && !match.$lte;
      if (match.$gte && date.getTime() < match.$gte.getTime()) return false;
      if (match.$lte && date.getTime() > match.$lte.getTime()) return false;
      return true;
    });

    const totals = filtered.reduce((acc, doc) => {
      const amount = Number(doc.amount || 0);
      const status = String(doc.status || '').toLowerCase();
      const paid = Boolean(doc.paidAt) || PAID_STATUSES.has(status);
      const closedUnpaid = CLOSED_UNPAID_STATUSES.has(status);
      acc.recordCount += 1;
      if (doc.type === 'revenue') {
        acc.totalRevenue += amount;
        acc.revenueRecordCount += 1;
      }
      if ((doc.type === 'invoice' || doc.type === 'revenue') && paid) acc.paidAmount += amount;
      if (doc.type === 'invoice') {
        acc.invoiceTotal += amount;
        acc.invoiceCount += 1;
        if (!paid && !closedUnpaid) acc.outstandingAmount += amount;
      }
      if (doc.type === 'receipt') acc.receiptCount += 1;
      if (doc.type === 'expense') {
        acc.expenseTotal += amount;
        acc.expenseCount += 1;
      }
      return acc;
    }, {
      _id: null,
      totalRevenue: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      recordCount: 0,
      invoiceTotal: 0,
      invoiceCount: 0,
      revenueRecordCount: 0,
      receiptCount: 0,
      expenseTotal: 0,
      expenseCount: 0,
    });

    const byCurrency = new Map();
    for (const doc of filtered) {
      const currency = doc.currency || 'INR';
      const current = byCurrency.get(currency) || { _id: currency, amount: 0, count: 0 };
      current.amount += Number(doc.amount || 0);
      current.count += 1;
      byCurrency.set(currency, current);
    }

    return [{
      totals: filtered.length ? [totals] : [],
      currencyBreakdown: Array.from(byCurrency.values()).sort((a, b) => b.amount - a.amount || a._id.localeCompare(b._id)),
    }];
  };
}

function methodsFor(router, path) {
  const methods = {};
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) Object.assign(methods, layer.route.methods);
  }
  return Object.keys(methods).length ? methods : null;
}

test('ad performance source query succeeds with zero counters and remains connected', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, Ad, 'aggregate', adAggregateFromDocs([]));

  const res = await auth(request(app()).get('/api/admin/analytics/ad-performance'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.source, 'ads_manager');
  assert.deepEqual(res.body.metrics, {
    impressions: 0,
    clicks: 0,
    ctr: 0,
    totalAds: 0,
    activeAds: 0,
  });
  assert.equal(res.body.scope, 'lifetime');
  assert.equal(res.body.dateRangeSupported, false);
});

test('ad performance aggregates impressions, clicks, CTR, and active ad count', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, Ad, 'aggregate', adAggregateFromDocs([
    { isActive: true, stats: { impressions: 100, clicks: 5 } },
    { isActive: false, stats: { impressions: 50, clicks: 10 } },
    { isActive: true, stats: { impressions: 0, clicks: 2 } },
  ]));

  const res = await auth(request(app()).get('/api/admin/analytics/ad-performance'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connected, true);
  assert.deepEqual(res.body.metrics, {
    impressions: 150,
    clicks: 17,
    ctr: 11.3333,
    totalAds: 3,
    activeAds: 2,
  });
});

test('ad performance does not fake date-range slicing', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, Ad, 'aggregate', async () => { throw new Error('lifetime aggregate should not be used for dated ad performance'); });
  stubMethod(t, AdPerformanceDaily, 'find', () => ({ lean: async () => [] }));
  stubMethod(t, Ad, 'find', () => ({ select: () => ({ lean: async () => [] }) }));

  const res = await auth(request(app()).get('/api/admin/analytics/ad-performance?dateFrom=2026-09-01&dateTo=2026-09-15'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.scope, 'custom');
  assert.equal(res.body.dateRangeSupported, true);
  assert.equal(res.body.metrics.impressions, 0);
  assert.equal(res.body.metrics.clicks, 0);
  assert.equal(res.body.metrics.ctr, 0);
  assert.deepEqual(res.body.dailyTrend, []);
});

test('admin analytics source routes use existing admin auth and GET-only methods', async () => {
  const unauthenticated = await request(app()).get('/api/admin/analytics/ad-performance');
  assert.equal(unauthenticated.statusCode, 401);

  const adMethods = methodsFor(analyticsRouter, '/ad-performance');
  const revenueMethods = methodsFor(analyticsRouter, '/revenue');
  assert.equal(adMethods.get, true);
  assert.equal(revenueMethods.get, true);
  assert.equal(Boolean(adMethods.post || adMethods.put || adMethods.patch || adMethods.delete), false);
  assert.equal(Boolean(revenueMethods.post || revenueMethods.put || revenueMethods.patch || revenueMethods.delete), false);

  const postRes = await auth(request(app()).post('/api/admin/analytics/ad-performance'));
  assert.equal(postRes.statusCode, 404);
});

test('revenue source query succeeds with zero FinanceRecords and remains connected', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, FinanceRecord, 'aggregate', financeAggregateFromDocs([]));

  const res = await auth(request(app()).get('/api/admin/analytics/revenue'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.source, 'finance_records');
  assert.equal(res.body.metrics.totalRevenue, 0);
  assert.equal(res.body.metrics.paidAmount, 0);
  assert.equal(res.body.metrics.outstandingAmount, 0);
  assert.equal(res.body.metrics.recordCount, 0);
  assert.deepEqual(res.body.metrics.currencyBreakdown, []);
});

test('revenue aggregates FinanceRecords without exposing private fields', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, FinanceRecord, 'aggregate', financeAggregateFromDocs([
    { type: 'revenue', amount: 1000, currency: 'INR', status: 'paid', paidAt: new Date('2026-09-01T10:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'), sponsorName: 'Private Sponsor' },
    { type: 'invoice', amount: 500, currency: 'INR', status: 'paid', paidAt: new Date('2026-09-02T10:00:00Z'), dueDate: new Date('2026-08-30T00:00:00Z'), createdAt: new Date('2026-08-01T00:00:00Z'), invoiceNumber: 'INV-PRIVATE' },
    { type: 'invoice', amount: 300, currency: 'INR', status: 'draft', dueDate: new Date('2026-09-10T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'), metadata: { paymentId: 'secret' } },
    { type: 'invoice', amount: 200, currency: 'INR', status: 'cancelled', dueDate: new Date('2026-09-10T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') },
    { type: 'receipt', amount: 50, currency: 'INR', status: 'uploaded', createdAt: new Date('2026-09-03T00:00:00Z'), receiptUrl: 'https://private.example/receipt.pdf' },
    { type: 'expense', amount: 100, currency: 'INR', status: 'approved', createdAt: new Date('2026-09-04T00:00:00Z') },
  ]));

  const res = await auth(request(app()).get('/api/admin/analytics/revenue'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.metrics.totalRevenue, 1000);
  assert.equal(res.body.metrics.paidAmount, 1500);
  assert.equal(res.body.metrics.outstandingAmount, 300);
  assert.equal(res.body.metrics.recordCount, 6);
  assert.equal(res.body.metrics.invoiceTotal, 1000);
  assert.equal(res.body.metrics.invoiceCount, 3);
  assert.equal(res.body.metrics.revenueRecordCount, 1);
  assert.equal(res.body.metrics.receiptCount, 1);
  assert.equal(res.body.metrics.expenseTotal, 100);
  assert.equal(res.body.metrics.expenseCount, 1);
  assert.deepEqual(res.body.metrics.currencyBreakdown, [{ currency: 'INR', amount: 2150, count: 6 }]);

  const raw = JSON.stringify(res.body);
  for (const privateField of ['sponsorName', 'invoiceNumber', 'receiptUrl', 'metadata', 'paymentId', 'Private Sponsor', 'INV-PRIVATE']) {
    assert.equal(raw.includes(privateField), false);
  }
});

test('revenue date filtering uses paidAt first, invoice dueDate second, then createdAt', async (t) => {
  stubReadyState(t, 1);
  let capturedPipeline = null;
  stubMethod(t, FinanceRecord, 'aggregate', financeAggregateFromDocs([
    { type: 'invoice', amount: 400, currency: 'INR', status: 'paid', paidAt: new Date('2026-09-05T12:00:00Z'), dueDate: new Date('2026-08-01T00:00:00Z'), createdAt: new Date('2026-08-01T00:00:00Z') },
    { type: 'invoice', amount: 300, currency: 'INR', status: 'draft', dueDate: new Date('2026-09-10T00:00:00Z'), createdAt: new Date('2026-08-15T00:00:00Z') },
    { type: 'revenue', amount: 1000, currency: 'INR', status: 'paid', createdAt: new Date('2026-08-31T00:00:00Z') },
    { type: 'expense', amount: 75, currency: 'INR', status: 'approved', createdAt: new Date('2026-09-12T00:00:00Z') },
  ], (pipeline) => { capturedPipeline = pipeline; }));

  const res = await auth(request(app()).get('/api/admin/analytics/revenue?dateFrom=2026-09-01&dateTo=2026-09-30'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.metrics.recordCount, 3);
  assert.equal(res.body.metrics.paidAmount, 400);
  assert.equal(res.body.metrics.outstandingAmount, 300);
  assert.equal(res.body.metrics.totalRevenue, 0);
  assert.equal(res.body.metrics.expenseTotal, 75);
  assert.equal(res.body.filters.dateFrom, '2026-09-01T00:00:00.000Z');
  assert.equal(res.body.filters.dateTo, '2026-09-30T23:59:59.999Z');
  assert.ok(capturedPipeline.some((stage) => stage.$match && stage.$match.analyticsDate));
});

test('revenue query failure returns a safe non-connected state', async (t) => {
  stubReadyState(t, 1);
  stubMethod(t, FinanceRecord, 'aggregate', async () => { throw new Error('database exploded with sensitive internals'); });

  const res = await auth(request(app()).get('/api/admin/analytics/revenue'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.source, 'finance_records');
  assert.equal(res.body.message, 'Revenue source unavailable');
  assert.equal(res.body.metrics.recordCount, 0);
  assert.equal(JSON.stringify(res.body).includes('sensitive internals'), false);
});

test('traffic analytics dashboard remains unchanged in database-unavailable fallback', async (t) => {
  stubReadyState(t, 0);

  const res = await auth(request(app()).get('/api/admin/analytics/dashboard'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  for (const key of [
    'avgReadTimeSec',
    'categoryBreakdown',
    'languageBreakdown',
    'last24hViews',
    'last7dViews',
    'topArticles',
    'topSources',
    'totalEngagedReads',
    'totalUniqueReaders',
    'totalViews',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.data, key), `missing ${key}`);
  }
  assert.equal(res.body.data.totalViews, 0);
  assert.equal(res.body.data.totalUniqueReaders, 0);
  assert.equal(res.body.data.totalEngagedReads, 0);
});

test('Ads Manager and Finance mutation routes remain registered outside Admin Analytics', () => {
  assert.equal(methodsFor(adminAdsRouter, '/ads').post, true);
  assert.equal(methodsFor(adminAdsRouter, '/ads/:id').put, true);
  assert.equal(methodsFor(adminAdsRouter, '/ads/:id/toggle').patch, true);
  assert.equal(methodsFor(adminAdsRouter, '/ads/:id').delete, true);

  assert.equal(methodsFor(financeRouter, '/invoices').post, true);
  assert.equal(methodsFor(financeRouter, '/invoices/:id').patch, true);
  assert.equal(methodsFor(financeRouter, '/expenses').post, true);
  assert.equal(methodsFor(financeRouter, '/receipts').post, true);
});