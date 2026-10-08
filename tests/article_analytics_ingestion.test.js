process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const Event = require('../models/ArticleAnalyticsEvent');
const Daily = require('../models/ArticleAnalyticsDaily');
const Summary = require('../models/ArticleAnalyticsSummary');
const Dedup = require('../models/ArticleAnalyticsDedup');

const TYPES = [
  { path: 'view', method: 'ingestView', event: 'view', extra: {}, daily: { views: 1, uniqueReaders: 1 }, summary: { totalViews: 1, totalUniqueReaders: 1 }, duplicate: 'view-cooldown' },
  { path: 'engagement', method: 'ingestEngagement', event: 'engaged_read', extra: { readTimeSec: 15, scrollPercent: 50 }, daily: { engagedReads: 1 }, summary: { totalEngagedReads: 1 }, duplicate: 'engaged-already-counted' },
  { path: 'scroll', method: 'ingestScroll', event: 'scroll_100', extra: { milestone: 100 }, daily: { scroll100Count: 1 }, summary: { scroll100Count: 1 }, duplicate: 'milestone-already-counted' },
  { path: 'heartbeat', method: 'ingestHeartbeat', event: 'heartbeat', extra: { readTimeSec: 10 }, daily: { totalReadTimeSec: 10 }, summary: { totalReadTimeSec: 10 }, duplicate: 'heartbeat-cooldown' },
];

function publishedArticle(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    sourceNewsId: new mongoose.Types.ObjectId(),
    slug: 'readership-test-story',
    category: 'national',
    language: 'gu',
    status: 'published',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function humanRequest() {
  return {
    ip: '198.51.100.10',
    headers: { origin: 'https://www.newspulse.co.in', host: 'api.example.invalid', 'user-agent': 'ReadershipTestBrowser' },
    query: {},
  };
}

function increments(calls) {
  const totals = {};
  for (const { update } of calls) {
    for (const [field, value] of Object.entries(update.$inc || {})) {
      if (!field.includes('.')) totals[field] = (totals[field] || 0) + value;
    }
  }
  return totals;
}

function fixture(t, article = publishedArticle()) {
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousState; });
  t.mock.method(mongoose, 'connect', () => assert.fail('Tests must not connect to MongoDB'));
  t.mock.method(mongoose, 'createConnection', () => assert.fail('Tests must not create a MongoDB connection'));
  for (const method of ['create', 'updateOne', 'findOneAndUpdate']) {
    t.mock.method(Article, method, () => assert.fail('Analytics must not write article content'));
  }

  const env = {
    ANALYTICS_ENABLED: 'true',
    ANALYTICS_ALLOW_LOCALHOST: 'false',
    ANALYTICS_ALLOW_UNPUBLISHED: 'false',
    ANALYTICS_VIEW_COOLDOWN_MS: '60000',
    ANALYTICS_HEARTBEAT_COOLDOWN_MS: '10000',
    ANALYTICS_HASH_SALT: 'readership-test-only',
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  const articles = [article];
  const lookups = { direct: [], linked: [] };
  const events = [];
  const daily = [];
  const summary = [];
  const dedup = new Map();
  const query = value => ({
    select(fields) {
      assert.equal(fields, 'slug category language status publishedAt');
      return this;
    },
    lean: async () => value,
  });
  t.mock.method(Article, 'findById', id => {
    lookups.direct.push(String(id));
    return query(articles.find(row => String(row._id) === String(id)) || null);
  });
  t.mock.method(Article, 'findOne', filter => {
    assert.deepEqual(Object.keys(filter), ['sourceNewsId']);
    lookups.linked.push(String(filter.sourceNewsId));
    return query(articles.find(row => String(row.sourceNewsId) === String(filter.sourceNewsId)) || null);
  });
  t.mock.method(Event, 'create', async doc => {
    assert.equal(new Event(doc).validateSync(), undefined);
    events.push(doc);
    return doc;
  });
  for (const [Model, calls] of [[Daily, daily], [Summary, summary]]) {
    t.mock.method(Model, 'updateOne', async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { acknowledged: true, modifiedCount: 1 };
    });
  }
  const key = doc => ['kind', 'articleId', 'visitorId', 'sessionId', 'dateKey', 'milestone'].map(field => String(doc[field])).join('|');
  t.mock.method(Dedup, 'updateOne', async (filter, update) => {
    const row = dedup.get(key(filter));
    if (!row || !(row.lastAt < filter.lastAt.$lt)) return { modifiedCount: 0 };
    Object.assign(row, update.$set);
    return { modifiedCount: 1 };
  });
  t.mock.method(Dedup, 'create', async doc => {
    assert.equal(new Dedup(doc).validateSync(), undefined);
    if (dedup.has(key(doc))) throw Object.assign(new Error('Duplicate test key'), { code: 11000 });
    dedup.set(key(doc), { ...doc });
    return doc;
  });

  // Reload only these modules so each test starts with an empty lookup cache.
  const modules = ['../services/articleAnalytics.service', '../controllers/articleAnalyticsController', '../routes/articleAnalytics.routes'];
  for (const name of modules) {
    const id = require.resolve(name);
    const previous = require.cache[id];
    delete require.cache[id];
    t.after(() => {
      if (previous) require.cache[id] = previous;
      else delete require.cache[id];
    });
  }
  const service = require('../services/articleAnalytics.service');
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', require('../routes/articleAnalytics.routes'));

  return {
    article, articles, lookups, events, daily, summary, dedup, service,
    payload(id = article._id, extra = {}) {
      return { articleId: String(id), visitorId: 'reader-one', sessionId: 'session-one', ...extra };
    },
    post(type, body, debug = false) {
      return request(app).post(`/api/analytics/article/${type.path}${debug ? '?debug=1' : ''}`)
        .set('Origin', 'https://www.newspulse.co.in')
        .set('Host', 'api.example.invalid')
        .set('X-Forwarded-For', '198.51.100.10')
        .set('User-Agent', 'ReadershipTestBrowser')
        .send(body);
    },
  };
}

for (const identity of ['direct', 'linked']) {
  for (const type of TYPES) {
    test(`${type.path}: ${identity} ID records the canonical Article ID in every store`, async t => {
      const f = fixture(t);
      const id = identity === 'direct' ? f.article._id : f.article.sourceNewsId;
      const res = await f.post(type, f.payload(id, type.extra));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, skipped: false });
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].eventType, type.event);
      assert.equal(String(f.events[0].articleId), String(f.article._id));
      assert.equal(f.events[0].language, 'gu');
      assert.deepEqual(f.lookups.direct, [String(id)]);
      assert.deepEqual(f.lookups.linked, identity === 'linked' ? [String(id)] : []);
      for (const row of f.dedup.values()) assert.equal(String(row.articleId), String(f.article._id));
      for (const { filter, update } of [...f.daily, ...f.summary]) {
        assert.equal(String(filter.articleId), String(f.article._id));
        if (update.$setOnInsert?.articleId) assert.equal(String(update.$setOnInsert.articleId), String(f.article._id));
      }
      assert.deepEqual(increments(f.daily), type.daily);
      assert.deepEqual(increments(f.summary), type.summary);
    });
  }
}

for (const type of TYPES) {
  test(`${type.path}: direct and linked IDs share duplicate suppression`, async t => {
    const f = fixture(t);
    const first = await f.service[type.method](humanRequest(), f.payload(f.article._id, type.extra));
    const second = await f.service[type.method](humanRequest(), f.payload(f.article.sourceNewsId, type.extra));
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, type.duplicate);
    assert.equal(f.events.length, 1);
    assert.deepEqual(increments(f.daily), type.daily);
    assert.deepEqual(increments(f.summary), type.summary);
  });

  for (const protection of ['unpublished', 'preview']) {
    test(`${type.path}: linked IDs preserve ${protection} protection`, async t => {
      const f = fixture(t, publishedArticle(protection === 'unpublished' ? { status: 'draft' } : {}));
      const body = f.payload(f.article.sourceNewsId, { ...type.extra, ...(protection === 'preview' ? { previewMode: true } : {}) });
      const res = await f.post(type, body, true);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.skipped, true);
      assert.equal(res.body.reason, protection === 'preview' ? 'preview-mode' : 'unpublished');
      assert.equal(f.events.length, 0);
      assert.equal(f.daily.length + f.summary.length + f.dedup.size, 0);
    });
  }
}

test('direct Article IDs take precedence over another record sourceNewsId', async t => {
  const f = fixture(t);
  f.articles.push(publishedArticle({ sourceNewsId: f.article._id }));
  const result = await f.service.ingestView(humanRequest(), f.payload());
  assert.equal(result.skipped, false);
  assert.equal(String(f.events[0].articleId), String(f.article._id));
  assert.deepEqual(f.lookups.linked, []);
});

test('resolved direct and News-ID lookup results stay independently cached', async t => {
  const f = fixture(t);
  for (const id of [f.article._id, f.article.sourceNewsId, f.article._id, f.article.sourceNewsId]) {
    await f.service.ingestView(humanRequest(), f.payload(id));
  }
  assert.deepEqual(f.lookups.direct, [String(f.article._id), String(f.article.sourceNewsId)]);
  assert.deepEqual(f.lookups.linked, [String(f.article.sourceNewsId)]);
  assert.equal(f.events.length, 1);

  const other = publishedArticle();
  f.articles.push(other);
  await f.service.ingestView(humanRequest(), f.payload(other.sourceNewsId));
  assert.equal(String(f.events[1].articleId), String(other._id));
});

test('misses cache only after both lookups; another ID can resolve and expired misses retry', async t => {
  const now = new Date('2026-10-09T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(t);
  const newsId = new mongoose.Types.ObjectId();
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.service.ingestView(humanRequest(), f.payload(newsId))).reason, 'article-not-found');
  }
  assert.deepEqual(f.lookups.direct, [String(newsId)]);
  assert.deepEqual(f.lookups.linked, [String(newsId)]);

  const linked = publishedArticle({ sourceNewsId: newsId });
  f.articles.push(linked);
  assert.equal((await f.service.ingestView(humanRequest(), f.payload(linked._id))).skipped, false);
  assert.equal((await f.service.ingestView(humanRequest(), f.payload(newsId))).reason, 'article-not-found');
  t.mock.timers.setTime(now.getTime() + 5 * 60_000 + 1);
  assert.equal((await f.service.ingestView(humanRequest(), f.payload(newsId))).skipped, false);
  assert.equal(String(f.events[1].articleId), String(linked._id));
  assert.equal(f.lookups.linked.filter(id => id === String(newsId)).length, 2);
});

test('unknown and malformed IDs preserve non-fatal missing/article-not-found responses', async t => {
  const f = fixture(t);
  for (const extra of [
    { articleId: 'not-an-object-id' }, { articleId: '' }, { visitorId: '' }, { sessionId: '' },
    { articleId: undefined, slug: f.article.slug },
  ]) {
    const res = await f.post(TYPES[0], f.payload(f.article._id, extra), true);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, skipped: true, reason: 'missing-ids' });
  }
  assert.deepEqual(f.lookups, { direct: [], linked: [] });
  const res = await f.post(TYPES[0], f.payload(new mongoose.Types.ObjectId()), true);
  assert.deepEqual(res.body, { ok: true, skipped: true, reason: 'article-not-found' });
  assert.equal(f.events.length + f.daily.length + f.summary.length + f.dedup.size, 0);
});

const SKIP_CASES = [
  ['disabled', req => req, () => { process.env.ANALYTICS_ENABLED = 'false'; }],
  ['loopback-ip', req => ({ ...req, ip: '127.0.0.1' })],
  ['localhost-origin', req => ({ ...req, headers: { ...req.headers, origin: 'http://localhost:3000' } })],
  ['admin-origin', req => ({ ...req, headers: { ...req.headers, origin: 'https://admin.newspulse.co.in' } })],
  ['bot-ua', req => ({ ...req, headers: { ...req.headers, 'user-agent': 'HeadlessChrome' } })],
  ['prefetch', req => ({ ...req, headers: { ...req.headers, 'sec-purpose': 'prefetch' } })],
  ['preview-mode', req => ({ ...req, query: { preview: '1' } })],
];

for (const [reason, makeRequest, configure] of SKIP_CASES) {
  test(`linked News IDs still skip ${reason}`, async t => {
    const f = fixture(t);
    if (configure) configure();
    const result = await f.service.ingestView(makeRequest(humanRequest()), f.payload(f.article.sourceNewsId));
    assert.equal(result.ok, true);
    assert.equal(result.reason, reason);
    assert.equal(f.events.length + f.daily.length + f.summary.length + f.dedup.size, 0);
  });
}

test('engagement thresholds, scroll milestones and incremental heartbeat limits stay unchanged', async t => {
  const f = fixture(t);
  const payload = extra => f.payload(f.article.sourceNewsId, extra);
  for (const extra of [{ readTimeSec: 14, scrollPercent: 100 }, { readTimeSec: 15, scrollPercent: 49 }]) {
    assert.equal((await f.service.ingestEngagement(humanRequest(), payload(extra))).reason, 'not-engaged');
  }
  assert.equal((await f.service.ingestEngagement(humanRequest(), payload({ readTimeSec: 15, scrollPercent: 50 }))).skipped, false);
  assert.equal((await f.service.ingestScroll(humanRequest(), payload({ milestone: 30 }))).reason, 'bad-milestone');
  for (const milestone of [25, 50, 75, 100]) {
    assert.equal((await f.service.ingestScroll(humanRequest(), payload({ milestone }))).skipped, false);
  }
  assert.equal((await f.service.ingestHeartbeat(humanRequest(), payload({ readTimeSec: 0 }))).reason, 'no-readtime');
  assert.equal((await f.service.ingestHeartbeat(humanRequest(), payload({ sessionId: 'another-session', readTimeSec: 999 }))).skipped, false);
  assert.equal(f.events.at(-1).readTimeSec, 300);
  assert.deepEqual(increments(f.daily), { engagedReads: 1, scroll25Count: 1, scroll50Count: 1, scroll75Count: 1, scroll100Count: 1, totalReadTimeSec: 300 });
  assert.deepEqual(increments(f.summary), { totalEngagedReads: 1, scroll25Count: 1, scroll50Count: 1, scroll75Count: 1, scroll100Count: 1, totalReadTimeSec: 300 });
  for (const [calls, views] of [[f.daily, 'views'], [f.summary, 'totalViews']]) {
    const derived = calls.find(call => Array.isArray(call.update)).update[0].$set;
    assert.deepEqual(derived.avgReadTimeSec.$cond[1], { $divide: ['$totalReadTimeSec', `$${views}`] });
    assert.deepEqual(derived.completionRate.$cond[1], { $divide: ['$scroll100Count', `$${views}`] });
  }
});

test('view/heartbeat cooldowns and per-day unique counters use one canonical identity', async t => {
  const now = new Date('2026-10-08T23:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(t);
  await f.service.ingestView(humanRequest(), f.payload(f.article._id));
  await f.service.ingestHeartbeat(humanRequest(), f.payload(f.article.sourceNewsId, { readTimeSec: 10 }));
  t.mock.timers.setTime(now.getTime() + 10_001);
  await f.service.ingestHeartbeat(humanRequest(), f.payload(f.article._id, { readTimeSec: 5 }));
  assert.equal((await f.service.ingestView(humanRequest(), f.payload(f.article.sourceNewsId))).reason, 'view-cooldown');
  t.mock.timers.setTime(now.getTime() + 60_001);
  await f.service.ingestView(humanRequest(), f.payload(f.article.sourceNewsId));
  assert.deepEqual(increments(f.daily), { views: 2, uniqueReaders: 1, totalReadTimeSec: 15 });
  t.mock.timers.setTime(now.getTime() + 24 * 60 * 60_000);
  await f.service.ingestView(humanRequest(), f.payload(f.article.sourceNewsId));
  assert.deepEqual(increments(f.summary), { totalViews: 3, totalUniqueReaders: 2, totalReadTimeSec: 15 });
  assert.deepEqual([...new Set(f.daily.map(call => call.filter.dateKey))], ['2026-10-08', '2026-10-09']);
});

for (const type of TYPES) {
  test(`${type.path}: storage failure returns a safe 500, not recorded success`, async t => {
    const f = fixture(t);
    const warning = t.mock.method(console, 'warn', () => {});
    t.mock.method(Event, 'create', async () => { throw new Error('DO_NOT_EXPOSE_STORAGE_INTERNALS'); });
    const res = await f.post(type, f.payload(f.article.sourceNewsId, type.extra));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false, skipped: true, message: 'Failed to record analytics event' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(JSON.stringify(warning.mock.calls[0].arguments).includes('DO_NOT_EXPOSE'), false);
  });
}

test('lookup exceptions and partial rollup failures return only generic debug failure reasons', async t => {
  const f = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const lookup = t.mock.method(Article, 'findOne', () => { throw new Error('DO_NOT_EXPOSE_QUERY_INTERNALS'); });
  let res = await f.post(TYPES[0], f.payload(f.article.sourceNewsId), true);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, skipped: true, message: 'Failed to record analytics event', reason: 'error' });
  lookup.mock.restore();
  t.mock.method(Daily, 'updateOne', async () => { throw new Error('DO_NOT_EXPOSE_ROLLUP_INTERNALS'); });
  res = await f.post(TYPES[0], f.payload(f.article.sourceNewsId), true);
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'error');
  assert.equal(JSON.stringify(res.body).includes('DO_NOT_EXPOSE'), false);
  assert.equal(f.events.length, 1);
});

test('unavailable database returns safe 503 responses for every ingestion route', async t => {
  const f = fixture(t);
  mongoose.connection.readyState = 0;
  for (const type of TYPES) {
    const res = await f.post(type, f.payload(f.article.sourceNewsId, type.extra), true);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, skipped: true, message: 'Analytics temporarily unavailable', reason: 'db-not-ready' });
  }
  assert.deepEqual(f.lookups, { direct: [], linked: [] });
  assert.equal(f.events.length + f.daily.length + f.summary.length + f.dedup.size, 0);
});
