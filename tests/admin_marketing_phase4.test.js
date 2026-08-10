const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const router = require('../routes/adminMarketingPhase4.routes');
const Ad = require('../models/Ad');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const MarketingCampaignLink = require('../models/MarketingCampaignLink');
const MarketingCampaignReport = require('../models/MarketingCampaignReport');
const MarketingRenewal = require('../models/MarketingRenewal');
const MarketingPromotionCampaign = require('../models/MarketingPromotionCampaign');
const MarketingSettings = require('../models/MarketingSettings');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

const authUsers = new Map();

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/admin-api/admin/marketing', router);
  return instance;
}

function token({ role = 'admin', permissions = [], specialRights = [], sub = '507f1f77bcf86cd799439011' } = {}) {
  authUsers.set(String(sub), {
    _id: sub,
    email: 'admin@newspulse.ai',
    name: 'Admin',
    role,
    status: 'active',
    accountStatus: 'active',
    loginAllowed: true,
    tokenVersion: 0,
    permissions,
    specialRightsOverride: specialRights,
    moduleAccessOverride: [],
    taskRightsOverride: [],
    accountControlRightsOverride: [],
    noExpiry: true,
    isFounder: role === 'founder',
    isProtected: role === 'founder',
  });
  return jwt.sign({ sub, email: 'admin@newspulse.ai', role, permissions, specialRights, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function auth(req, options) {
  return req.set('Authorization', `Bearer ${token(options)}`);
}

function queryOne(value) {
  return {
    sort() { return this; },
    select() { return this; },
    lean: async () => value,
  };
}

function queryMany(values) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => values,
  };
}

function makeDoc(data) {
  return {
    ...data,
    statusHistory: Array.isArray(data.statusHistory) ? data.statusHistory : [],
    save: async function save() { return this; },
  };
}

function withStubs(stubs, fn) {
  const originals = [];
  const allStubs = [
    [User, 'findById', (id) => ({ lean: async () => authUsers.get(String(id)) || null })],
    [User, 'findOne', (filter) => ({ lean: async () => {
      const email = String(filter?.email || '').toLowerCase();
      return Array.from(authUsers.values()).find((user) => String(user.email || '').toLowerCase() === email) || null;
    } })],
    ...stubs,
  ];
  for (const [obj, key, value] of allStubs) {
    originals.push([obj, key, obj[key]]);
    obj[key] = value;
  }
  const prevReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      mongoose.connection.readyState = prevReadyState;
      for (const [obj, key, value] of originals.reverse()) obj[key] = value;
    });
}

const campaignObjectId = '507f1f77bcf86cd799439021';
const adObjectId = '507f1f77bcf86cd799439022';

function campaignLink(overrides = {}) {
  return {
    _id: campaignObjectId,
    campaignLinkId: 'MCL-1',
    advertiserId: 'ADV-1',
    advertiserName: 'ACME',
    dealId: 'DEAL-1',
    proposalId: 'PROP-1',
    adsManagerCampaignId: adObjectId,
    campaignName: 'Launch',
    status: 'active',
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-08-10T00:00:00Z'),
    placements: ['HOME_728x90'],
    languages: ['en'],
    targetRegion: 'Gujarat',
    ownerId: 'OWN-1',
    updatedAt: new Date('2026-08-09T00:00:00Z'),
    archivedAt: null,
    ...overrides,
  };
}

test('marketing performance endpoints require server-side permission', async () => {
  await withStubs([], async () => {
    const res = await auth(request(app()).get('/admin-api/admin/marketing/performance/campaigns'), {
      permissions: [],
      specialRights: [],
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  });
});

test('marketing root endpoint requires admin auth', async () => {
  const res = await request(app()).get('/admin-api/admin/marketing');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('marketing root endpoint requires marketing performance permission', async () => {
  await withStubs([], async () => {
    const res = await auth(request(app()).get('/admin-api/admin/marketing'), {
      permissions: [],
      specialRights: [],
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  });
});

test('marketing root endpoint returns real empty overview state', async () => {
  const previousAnalyticsEnabled = process.env.ANALYTICS_ENABLED;
  process.env.ANALYTICS_ENABLED = 'false';

  try {
    await withStubs([
      [MarketingCampaignLink, 'countDocuments', async () => 0],
      [MarketingPromotionCampaign, 'countDocuments', async () => 0],
      [MarketingRenewal, 'countDocuments', async () => 0],
      [MarketingCampaignReport, 'countDocuments', async () => 0],
      [Ad, 'findOne', () => queryOne(null)],
      [ArticleAnalyticsSummary, 'findOne', () => queryOne(null)],
      [ArticleAnalyticsEvent, 'findOne', () => queryOne(null)],
    ], async () => {
      const res = await auth(request(app()).get('/admin-api/admin/marketing'), {
        specialRights: ['view_marketing_performance'],
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.counts, {
        activeAdvertiserCampaigns: 0,
        completedAdvertiserCampaigns: 0,
        activePromotions: 0,
        completedPromotions: 0,
        renewalsDue: 0,
        reportsReady: 0,
      });
      assert.equal(res.body.analytics.status, 'not_connected');
      assert.equal(res.body.analytics.websiteUsers, null);
      assert.equal(res.body.analytics.campaignSessions, null);
      assert.equal(res.body.sourceStatus.trafficAnalytics.status, 'not_connected');
    });
  } finally {
    if (previousAnalyticsEnabled == null) delete process.env.ANALYTICS_ENABLED;
    else process.env.ANALYTICS_ENABLED = previousAnalyticsEnabled;
  }
});

test('campaign performance reads Ads Manager stats and calculates CTR', async () => {
  const link = campaignLink();
  const ad = { _id: adObjectId, stats: { impressions: 200, clicks: 10 }, updatedAt: new Date('2026-08-09T10:00:00Z') };

  await withStubs([
    [MarketingCampaignLink, 'countDocuments', async () => 1],
    [MarketingCampaignLink, 'find', () => queryMany([link])],
    [Ad, 'findOne', () => queryOne(ad)],
    [Ad, 'findById', () => queryOne(ad)],
    [ArticleAnalyticsSummary, 'findOne', () => queryOne(null)],
    [ArticleAnalyticsEvent, 'findOne', () => queryOne(null)],
  ], async () => {
    const res = await auth(request(app()).get('/admin-api/admin/marketing/performance/campaigns'), {
      specialRights: ['view_campaign_performance'],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items[0].performance.impressions, 200);
    assert.equal(res.body.items[0].performance.clicks, 10);
    assert.equal(res.body.items[0].performance.ctr, 5);
    assert.equal(res.body.items[0].performance.trackingStatus, 'connected');
  });
});

test('campaign performance distinguishes unavailable impressions from real zero', async () => {
  const link = campaignLink();

  await withStubs([
    [MarketingCampaignLink, 'countDocuments', async () => 1],
    [MarketingCampaignLink, 'find', () => queryMany([link])],
    [Ad, 'findOne', () => queryOne(null)],
    [Ad, 'findById', () => queryOne(null)],
    [ArticleAnalyticsSummary, 'findOne', () => queryOne(null)],
    [ArticleAnalyticsEvent, 'findOne', () => queryOne(null)],
  ], async () => {
    const res = await auth(request(app()).get('/admin-api/admin/marketing/performance/campaigns'), {
      specialRights: ['view_campaign_performance'],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items[0].performance.impressions, null);
    assert.equal(res.body.items[0].performance.clicks, null);
    assert.equal(res.body.items[0].performance.ctr, null);
    assert.equal(res.body.items[0].performance.trackingStatus, 'not_connected');
  });
});

test('campaign report update protects metrics from manual overwrite', async () => {
  const report = makeDoc({
    _id: '507f1f77bcf86cd799439031',
    reportId: 'MCR-1',
    advertiserId: 'ADV-1',
    title: 'Original',
    status: 'draft',
    performanceSnapshot: { impressions: 100, clicks: 4, ctr: 4, trackingStatus: 'connected', source: 'ads_manager' },
  });
  let updatePatch = null;

  await withStubs([
    [MarketingCampaignReport, 'findOne', async () => report],
    [MarketingCampaignReport, 'findByIdAndUpdate', async (_id, update) => { updatePatch = update.$set; return { ...report, ...update.$set }; }],
  ], async () => {
    const res = await auth(request(app())
      .patch('/admin-api/admin/marketing/campaign-reports/MCR-1')
      .send({ title: 'Updated', summary: 'Real notes', performanceSnapshot: { impressions: 999 }, ctr: 99 }), {
      specialRights: ['create_campaign_report'],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(updatePatch.title, 'Updated');
    assert.equal(updatePatch.summary, 'Real notes');
    assert.equal(Object.prototype.hasOwnProperty.call(updatePatch, 'performanceSnapshot'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(updatePatch, 'ctr'), false);
  });
});

test('renewal creation prevents duplicate active renewals', async () => {
  const existing = { _id: '507f1f77bcf86cd799439041', renewalId: 'MRN-1', advertiserId: 'ADV-1', previousDealId: 'DEAL-1', previousCampaignId: 'MCL-1', status: 'contacted' };

  await withStubs([
    [MarketingRenewal, 'findOne', () => queryOne(existing)],
  ], async () => {
    const res = await auth(request(app())
      .post('/admin-api/admin/marketing/renewals')
      .send({ advertiserId: 'ADV-1', ownerId: 'OWN-1', previousDealId: 'DEAL-1', previousCampaignId: 'MCL-1', followUpDate: '2026-08-12' }), {
      specialRights: ['manage_renewals'],
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DUPLICATE_RENEWAL');
  });
});

test('approval setting blocks sharing before approval without approval right', async () => {
  const report = makeDoc({
    _id: '507f1f77bcf86cd799439051',
    reportId: 'MCR-2',
    advertiserId: 'ADV-1',
    title: 'Ready report',
    status: 'ready',
    performanceSnapshot: { trackingStatus: 'connected', source: 'ads_manager' },
  });

  await withStubs([
    [MarketingCampaignReport, 'findOne', async () => report],
    [MarketingSettings, 'findById', () => queryOne({ _id: 'global', requireCampaignReportApproval: true })],
  ], async () => {
    const res = await auth(request(app()).post('/admin-api/admin/marketing/campaign-reports/MCR-2/shared').send({ sharedVia: 'email' }), {
      specialRights: ['create_campaign_report'],
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'APPROVAL_REQUIRED');
  });
});

test('exports require export permission and audit successful export', async () => {
  let auditAction = null;

  await withStubs([
    [MarketingRenewal, 'countDocuments', async () => 1],
    [MarketingRenewal, 'find', () => queryMany([{ renewalId: 'MRN-1', advertiserId: 'ADV-1', ownerId: 'OWN-1', status: 'upcoming', followUpDate: new Date('2026-08-12') }])],
    [AuditLog, 'create', async (doc) => { auditAction = doc.action; return doc; }],
  ], async () => {
    const denied = await auth(request(app()).get('/admin-api/admin/marketing/renewals/export.csv'), {
      specialRights: ['view_renewals'],
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await auth(request(app()).get('/admin-api/admin/marketing/renewals/export.csv'), {
      specialRights: ['export_marketing_performance'],
    });
    assert.equal(allowed.statusCode, 200);
    assert.match(allowed.text, /renewalId,advertiserId/);
    assert.equal(auditAction, 'MARKETING_PERFORMANCE_EXPORT');
  });
});
