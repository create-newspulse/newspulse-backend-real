const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const CommunitySubmission = require('../models/CommunitySubmission');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const firebaseAdminLib = require('../lib/firebaseAdmin');
const User = require('../models/User');

const HEALTH_PATH = '/api/admin/news-pulse-engine/health';
const STAFF_EMAIL = 'staff@newspulse.ai';

function signAdminToken(role) {
  return jwt.sign(
    { sub: 'staff-id', email: STAFF_EMAIL, role },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
}

// requireAdminAuth resolves the user by email when the JWT `sub` isn't a valid ObjectId.
function stubAdminUser(t, role) {
  const prevFindOne = User.findOne;
  t.after(() => { User.findOne = prevFindOne; });
  User.findOne = () => ({
    lean: async () => ({ email: STAFF_EMAIL, role, isFounder: role === 'founder', status: 'active' }),
  });
}

function stubDbReady(t, ready = true) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = ready ? 1 : 0;
}

function chainResult(finalValue) {
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    lean: async () => finalValue,
  };
  return chain;
}

function stubPublishing(t, latestPublishedAt) {
  const prevFindOne = News.findOne;
  t.after(() => { News.findOne = prevFindOne; });
  News.findOne = () => chainResult(latestPublishedAt === undefined ? null : { publishedAt: latestPublishedAt });
}

function stubCommunitySubmission(t, doc) {
  const prevFindOne = CommunitySubmission.findOne;
  t.after(() => { CommunitySubmission.findOne = prevFindOne; });
  CommunitySubmission.findOne = () => ({ select: () => ({ lean: async () => (doc === undefined ? null : doc) }) });
}

function stubFirebaseStatus(t, status) {
  const prev = firebaseAdminLib.getFirebaseAdminStatus;
  t.after(() => { firebaseAdminLib.getFirebaseAdminStatus = prev; });
  firebaseAdminLib.getFirebaseAdminStatus = () => status;
}

function stubAnalyticsEnabled(t, enabled) {
  const prev = process.env.ANALYTICS_ENABLED;
  t.after(() => {
    if (prev === undefined) delete process.env.ANALYTICS_ENABLED;
    else process.env.ANALYTICS_ENABLED = prev;
  });
  process.env.ANALYTICS_ENABLED = enabled ? 'true' : 'false';
}

function stubAnalyticsHashSalt(t, value) {
  const prev = process.env.ANALYTICS_HASH_SALT;
  t.after(() => {
    if (prev === undefined) delete process.env.ANALYTICS_HASH_SALT;
    else process.env.ANALYTICS_HASH_SALT = prev;
  });
  if (value === undefined) delete process.env.ANALYTICS_HASH_SALT;
  else process.env.ANALYTICS_HASH_SALT = value;
}

function stubFirstPartyAnalyticsActivity(t, { latestEventAt = null, latestSummaryAt = null, fail = false } = {}) {
  const prevEventFindOne = ArticleAnalyticsEvent.findOne;
  const prevSummaryFindOne = ArticleAnalyticsSummary.findOne;
  t.after(() => {
    ArticleAnalyticsEvent.findOne = prevEventFindOne;
    ArticleAnalyticsSummary.findOne = prevSummaryFindOne;
  });

  if (fail) {
    ArticleAnalyticsEvent.findOne = () => { throw new Error('analytics lookup failed'); };
    ArticleAnalyticsSummary.findOne = () => { throw new Error('analytics lookup failed'); };
    return;
  }

  ArticleAnalyticsEvent.findOne = () => chainResult(latestEventAt ? { createdAt: latestEventAt } : null);
  ArticleAnalyticsSummary.findOne = () => chainResult(latestSummaryAt ? { updatedAt: latestSummaryAt } : null);
}

function fakeResponse(status) {
  return { status, ok: status >= 200 && status < 300 };
}

// Default: everything reachable and healthy unless overridden per-URL.
function stubFetch(t, { homepageStatus = 200, robotsStatus = 200, sitemapStatus = 200, homepageThrows = false } = {}) {
  const prev = global.__NEWS_PULSE_ENGINE_HEALTH_FETCH__;
  t.after(() => { global.__NEWS_PULSE_ENGINE_HEALTH_FETCH__ = prev; });

  global.__NEWS_PULSE_ENGINE_HEALTH_FETCH__ = async (url) => {
    const u = String(url);
    if (u.endsWith('/robots.txt')) return fakeResponse(robotsStatus);
    if (u.endsWith('/sitemap.xml')) return fakeResponse(sitemapStatus);
    if (homepageThrows) throw new Error('network unreachable');
    return fakeResponse(homepageStatus);
  };
}

function defaultStubs(t, analytics = {}) {
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured', projectId: 'np-project', credentialSource: 'env_service_account', messagingAvailable: true, error: null });
  stubFirstPartyAnalyticsActivity(t, analytics);
  stubFetch(t, {});
}

test('Founder can access the health endpoint', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('Admin cannot access the health endpoint (403)', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'admin');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('admin')}`);

  assert.equal(res.status, 403);
});

test('Manager/staff cannot access the health endpoint (403)', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'manager');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('manager')}`);

  assert.equal(res.status, 403);
});

test('Unauthenticated request follows existing 401 auth behavior', async (t) => {
  stubDbReady(t);
  defaultStubs(t);

  const res = await request(app).get(HEALTH_PATH);

  assert.equal(res.status, 401);
});

test('Response contains checkedAt, overallStatus, summary, and checks', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.checkedAt, 'string');
  assert.equal(typeof res.body.overallStatus, 'string');
  assert.equal(typeof res.body.summary, 'object');
  assert.ok(Array.isArray(res.body.checks));
  assert.ok(res.body.checks.length > 0);
});

test('Backend API check reports healthy', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const backendCheck = res.body.checks.find((c) => c.id === 'backend-api');
  assert.equal(backendCheck.status, 'healthy');
});

test('Database connected reports healthy', async (t) => {
  stubDbReady(t, true);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const dbCheck = res.body.checks.find((c) => c.id === 'database');
  assert.equal(dbCheck.status, 'healthy');
});

test('Database disconnected is handled safely (critical, not a crash)', async (t) => {
  stubDbReady(t, false);
  stubPublishing(t, undefined);
  stubCommunitySubmission(t, undefined);
  stubFirebaseStatus(t, { configured: true, status: 'configured', projectId: 'np-project', credentialSource: 'env_service_account' });
  stubFetch(t, {});

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.status, 200);
  const dbCheck = res.body.checks.find((c) => c.id === 'database');
  assert.equal(dbCheck.status, 'critical');
});

test('Public website HTTP 200 reports healthy', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  assert.equal(siteCheck.status, 'healthy');
});

test('Public website failure reports critical, not a crash', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageThrows: true });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.status, 200);
  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  assert.equal(siteCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'critical');
});

test('Public homepage HTTP 500 reports critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageStatus: 500 });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  assert.equal(siteCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'critical');
});

test('Public homepage HTTP 404 reports critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageStatus: 404 });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  assert.equal(siteCheck.status, 'critical');
});

test('Public homepage timeout/network failure reports critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageThrows: true });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  assert.equal(siteCheck.status, 'critical');
});

test('SEO robots/sitemap failure remains attention even when public website is critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageStatus: 500, robotsStatus: 500, sitemapStatus: 500 });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const siteCheck = res.body.checks.find((c) => c.id === 'public-website');
  const seoCheck = res.body.checks.find((c) => c.id === 'seo');
  assert.equal(siteCheck.status, 'critical');
  assert.equal(seoCheck.status, 'attention');
  assert.notEqual(seoCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'critical');
});

test('Analytics enabled with no recent first-party activity reports attention', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFirstPartyAnalyticsActivity(t, {});
  stubFetch(t, {});
  stubAnalyticsEnabled(t, true);
  stubAnalyticsHashSalt(t, undefined);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.equal(analyticsCheck.message, 'News Pulse analytics is enabled, but recent activity could not be confirmed.');
  assert.equal(analyticsCheck.recommendation, 'Verify that consented production article traffic is reaching News Pulse analytics.');
  assert.equal(analyticsCheck.recommendation.includes('approved analytics provider'), false);
});

test('Analytics disabled reports attention with first-party recommendation, not critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, {});
  stubAnalyticsEnabled(t, false);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.equal(analyticsCheck.message, 'News Pulse analytics collection is disabled.');
  assert.equal(analyticsCheck.recommendation, 'Enable News Pulse analytics collection if first-party traffic reporting is appropriate.');
  assert.equal(analyticsCheck.recommendation.includes('GA4'), false);
  assert.equal(analyticsCheck.recommendation.includes('approved analytics provider'), false);
  assert.notEqual(analyticsCheck.status, 'critical');
});

test('Analytics enabled with recent first-party event reports healthy', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t, { latestEventAt: new Date(Date.now() - 60 * 1000) });
  stubAnalyticsEnabled(t, true);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'healthy');
  assert.equal(analyticsCheck.message, 'News Pulse analytics collection is active.');
  assert.equal(analyticsCheck.recommendation, null);
  assert.match(analyticsCheck.technicalDetail, /latestActivityAt=/);
  assert.equal(res.body.overallStatus, 'healthy');
});

test('Analytics enabled with recent first-party summary reports healthy', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t, { latestSummaryAt: new Date(Date.now() - 5 * 60 * 1000) });
  stubAnalyticsEnabled(t, true);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'healthy');
  assert.equal(analyticsCheck.message, 'News Pulse analytics collection is active.');
  assert.equal(res.body.overallStatus, 'healthy');
});

test('Analytics health uses newest event or summary timestamp', async (t) => {
  const staleSummary = new Date(Date.now() - 26 * 60 * 60 * 1000);
  const recentEvent = new Date(Date.now() - 2 * 60 * 1000);
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t, { latestEventAt: recentEvent, latestSummaryAt: staleSummary });
  stubAnalyticsEnabled(t, true);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'healthy');
  assert.ok(analyticsCheck.technicalDetail.includes(recentEvent.toISOString()));
});

test('Analytics enabled with stale first-party activity reports attention, not critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t, { latestEventAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
  stubAnalyticsEnabled(t, true);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.equal(analyticsCheck.message, 'News Pulse analytics is enabled, but recent activity could not be confirmed.');
  assert.notEqual(analyticsCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'attention');
});

test('Analytics lookup failure reports attention, not critical', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t, { fail: true });
  stubAnalyticsEnabled(t, true);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.equal(analyticsCheck.message, 'News Pulse analytics health could not be confirmed.');
  assert.notEqual(analyticsCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'attention');
});

test('Analytics with only ANALYTICS_HASH_SALT set still reports attention without recent activity', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFirstPartyAnalyticsActivity(t, {});
  stubFetch(t, {});
  stubAnalyticsHashSalt(t, 'real-configured-salt');

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.notEqual(analyticsCheck.status, 'healthy');
});

test('Push status does not expose credentials', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFetch(t, {});
  stubFirebaseStatus(t, {
    configured: false,
    status: 'initialization_error',
    projectId: 'np-project',
    credentialSource: 'env_service_account',
    error: 'FIREBASE_PRIVATE_KEY=super-secret-key-should-not-leak',
  });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('super-secret-key-should-not-leak'));
  assert.ok(!serialized.includes('FIREBASE_PRIVATE_KEY'));
  const pushCheck = res.body.checks.find((c) => c.id === 'push-notifications');
  assert.equal(pushCheck.status, 'critical');
});

test('Community Reporter check does not expose private submission data', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, {});
  stubCommunitySubmission(t, {
    _id: 'sub-1',
    reporterName: 'Jane Doe',
    reporterEmail: 'jane@example.com',
    story: 'Private submission content',
  });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('Jane Doe'));
  assert.ok(!serialized.includes('jane@example.com'));
  assert.ok(!serialized.includes('Private submission content'));
  const reporterCheck = res.body.checks.find((c) => c.id === 'community-reporter');
  assert.equal(reporterCheck.status, 'healthy');
});

test('One failed external check does not crash the whole health response', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, { homepageThrows: true });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.checks.length, 9);
  const backendCheck = res.body.checks.find((c) => c.id === 'backend-api');
  assert.equal(backendCheck.status, 'healthy');
});

test('Secrets are absent from the serialized response', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    MONGODB_URI: process.env.MONGODB_URI,
  };
  process.env.MONGODB_URI = 'mongodb+srv://realuser:realpassword@cluster0.example.mongodb.net/prod';
  t.after(() => {
    if (previousEnv.MONGODB_URI === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousEnv.MONGODB_URI;
  });

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('realpassword'));
  assert.ok(!serialized.includes('mongodb+srv://'));
  assert.ok(!serialized.toLowerCase().includes(String(process.env.JWT_SECRET || 'dev-secret-change-me').toLowerCase()));
});

test('Overall status escalates to critical only for core system failures', async (t) => {
  stubDbReady(t, false);
  stubPublishing(t, undefined);
  stubCommunitySubmission(t, undefined);
  stubFirebaseStatus(t, { configured: true, status: 'configured' });
  stubFetch(t, {});

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.body.overallStatus, 'critical');
});

test('Overall status is attention when only non-core checks need review', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubPublishing(t, new Date('2026-01-01T00:00:00.000Z'));
  stubCommunitySubmission(t, { _id: 'sub-1' });
  stubFirebaseStatus(t, { configured: false, status: 'not_configured' });
  stubFetch(t, {});

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  assert.equal(res.body.overallStatus, 'attention');
});

test('Overall status is attention, not critical, when only analytics lacks recent activity', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  defaultStubs(t);

  const res = await request(app)
    .get(HEALTH_PATH)
    .set('Authorization', `Bearer ${signAdminToken('founder')}`);

  const analyticsCheck = res.body.checks.find((c) => c.id === 'analytics');
  assert.equal(analyticsCheck.status, 'attention');
  assert.notEqual(analyticsCheck.status, 'critical');
  assert.equal(res.body.overallStatus, 'attention');
});
