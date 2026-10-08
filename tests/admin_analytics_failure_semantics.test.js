process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'readership-response-test-only';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const Event = require('../models/ArticleAnalyticsEvent');
const Daily = require('../models/ArticleAnalyticsDaily');
const Summary = require('../models/ArticleAnalyticsSummary');
const controller = require('../controllers/adminAnalyticsController');
const router = require('../routes/adminAnalytics.routes');
const { accountAuthFixture } = require('./helpers/accountAuthFixture');

const ARTICLE_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439201');
const ROUTES = [
  { path: 'dashboard', method: 'getDashboard', failure: 'Failed to load analytics dashboard' },
  { path: 'articles', method: 'listArticles', failure: 'Failed to load article analytics' },
  { path: `articles/${ARTICLE_ID}`, method: 'getArticleDetails', failure: 'Failed to load article analytics' },
  { path: 'categories', method: 'listCategories', failure: 'Failed to load category analytics' },
];

function query(value) {
  return { select() { return this; }, sort() { return this; }, lean: async () => value };
}

function fixture(t) {
  const auth = accountAuthFixture();
  auth.install(t);
  t.mock.method(mongoose, 'connect', () => assert.fail('Tests must not connect to MongoDB'));
  t.mock.method(mongoose, 'createConnection', () => assert.fail('Tests must not create a MongoDB connection'));
  const article = {
    _id: ARTICLE_ID,
    title: 'Readership test article',
    slug: 'readership-test-article',
    category: 'national',
    language: 'gu',
    status: 'published',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
  };
  t.mock.method(Article, 'find', () => query([article]));
  t.mock.method(Article, 'findById', () => query(article));
  t.mock.method(Event, 'aggregate', async () => []);
  t.mock.method(Event, 'countDocuments', async () => 0);
  t.mock.method(Summary, 'findOne', () => query(null));
  t.mock.method(Daily, 'find', () => query([]));
  const app = express();
  app.use('/api/admin/analytics', router);
  return {
    article, app,
    get(path) {
      return request(app).get(`/api/admin/analytics/${path}`).set('Authorization', `Bearer ${auth.token()}`);
    },
  };
}

test('genuine empty dashboard retains its successful zero-state shape', async t => {
  const f = fixture(t);
  const res = await f.get('dashboard');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, data: {
    totalViews: 0,
    views: 0,
    totalUniqueReaders: 0,
    uniqueReaders: 0,
    uniqueVisitors: 0,
    totalEngagedReads: 0,
    engagedReads: 0,
    avgReadTimeSec: 0,
    completionRate: 0,
    topSources: [],
    languageBreakdown: [],
    topArticles: [],
    categoryBreakdown: [],
    last24hViews: 0,
    last7dViews: 0,
    scope: 'lifetime',
    dateRange: { dateFrom: null, dateTo: null, semantics: 'all stored analytics events' },
  } });
});

test('article and category analytics retain legitimate zero and empty results', async t => {
  const f = fixture(t);
  const articles = await f.get('articles');
  assert.equal(articles.status, 200);
  assert.equal(articles.body.ok, true);
  assert.equal(articles.body.items[0].title, f.article.title);
  assert.equal(articles.body.items[0].views, 0);
  assert.equal(articles.body.items[0].uniqueReaders, 0);
  const details = await f.get(`articles/${ARTICLE_ID}`);
  assert.equal(details.status, 200);
  assert.equal(details.body.ok, true);
  assert.equal(details.body.data.totals.totalViews, 0);
  assert.deepEqual(details.body.data.recentTrend, []);
  const categories = await f.get('categories');
  assert.equal(categories.status, 200);
  assert.deepEqual(categories.body.items, []);
});

for (const route of ROUTES) {
  test(`${route.path}: query failure is a safe 500 without fake metrics`, async t => {
    const f = fixture(t);
    const log = t.mock.method(console, 'error', () => {});
    const fail = () => { throw new Error('DO_NOT_EXPOSE_DATABASE_INTERNALS'); };
    if (route.method === 'listArticles') t.mock.method(Article, 'find', fail);
    else if (route.method === 'getArticleDetails') t.mock.method(Summary, 'findOne', fail);
    else t.mock.method(Event, 'aggregate', fail);
    const res = await f.get(route.path);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false, message: route.failure });
    assert.equal(log.mock.callCount(), 1);
    assert.equal(JSON.stringify(log.mock.calls[0].arguments).includes('DO_NOT_EXPOSE'), false);
  });

  test(`${route.path}: controller reports unavailable database without fabricated data`, async t => {
    fixture(t);
    mongoose.connection.readyState = 0;
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller[route.method]({ query: {}, params: { articleId: String(ARTICLE_ID) } }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, message: 'Analytics temporarily unavailable' });
  });
}

test('asynchronous dashboard aggregation rejection does not become a successful empty dataset', async t => {
  const f = fixture(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(Event, 'aggregate', async () => { throw new Error('DO_NOT_EXPOSE_AGGREGATION_INTERNALS'); });
  const res = await f.get('dashboard');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, message: 'Failed to load analytics dashboard' });
});

test('healthy dashboard/article/category responses preserve metrics and canonical IDs', async t => {
  const f = fixture(t);
  const metric = {
    articleId: ARTICLE_ID, views: 2, uniqueReaders: 1, visitorIds: ['reader-one'],
    engagedReads: 1, totalReadTimeSec: 60, scroll100Count: 1,
    avgReadTimeSec: 30, completionRate: 0.5,
    slug: f.article.slug, category: f.article.category, language: f.article.language,
  };
  t.mock.method(Event, 'aggregate', async pipeline => {
    const group = pipeline.find(stage => stage.$group).$group;
    if (group._id === null || group._id === '$articleId') return [metric];
    return [{ _id: group._id.$ifNull[0] === '$source' ? 'direct' : 'gu', count: 2 }];
  });
  t.mock.method(Event, 'countDocuments', async () => 2);
  const dashboard = await f.get('dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.totalViews, 2);
  assert.equal(dashboard.body.data.uniqueReaders, 1);
  assert.equal(dashboard.body.data.totalEngagedReads, 1);
  assert.equal(dashboard.body.data.avgReadTimeSec, 30);
  assert.equal(dashboard.body.data.completionRate, 0.5);
  const articles = await f.get('articles');
  const categories = await f.get('categories');
  for (const row of [articles.body.items[0], categories.body.items[0]]) {
    assert.equal(row.views, 2);
    assert.equal(row.uniqueReaders, 1);
    assert.equal(row.avgReadTimeSec, 30);
    assert.equal(row.completionRate, 0.5);
  }
  assert.equal(articles.body.items[0].articleId, String(ARTICLE_ID));
  assert.equal(JSON.stringify(dashboard.body).includes('reader-one'), false);
});

test('date-range validation and UTC boundaries remain unchanged', async t => {
  const f = fixture(t);
  const matches = [];
  t.mock.method(Event, 'aggregate', async pipeline => {
    matches.push(pipeline[0].$match);
    return [];
  });
  const res = await f.get('dashboard?dateFrom=2026-10-08&dateTo=2026-10-09');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.dateRange, {
    dateFrom: '2026-10-08T00:00:00.000Z',
    dateTo: '2026-10-09T23:59:59.999Z',
    semantics: 'rolling createdAt range',
  });
  for (const match of matches) {
    assert.equal(match.createdAt.$gte.toISOString(), '2026-10-08T00:00:00.000Z');
    assert.equal(match.createdAt.$lte.toISOString(), '2026-10-09T23:59:59.999Z');
  }
  const invalid = await f.get('dashboard?dateFrom=2026-10-09&dateTo=2026-10-08');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.ok, false);
});

test('readership endpoints retain signed Admin authentication', async t => {
  const f = fixture(t);
  for (const route of ROUTES) {
    const res = await request(f.app).get(`/api/admin/analytics/${route.path}`);
    assert.equal(res.status, 401);
  }
});
