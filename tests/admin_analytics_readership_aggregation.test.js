process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-analytics-readership-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const analyticsRouter = require('../routes/adminAnalytics.routes');
const Article = require('../models/Article');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');

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

function stubReadyState(t) {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previous; });
}

function stubMethod(t, object, key, value) {
  const previous = object[key];
  object[key] = value;
  t.after(() => { object[key] = previous; });
}

function article(id, overrides = {}) {
  return {
    _id: id,
    title: overrides.title || `Article ${id.slice(-1)}`,
    slug: overrides.slug || `article-${id.slice(-1)}`,
    category: overrides.category || 'regional',
    language: overrides.language || 'en',
    status: overrides.status || 'published',
    publishedAt: overrides.publishedAt || new Date('2026-09-01T00:00:00.000Z'),
  };
}

function event(articleId, eventType, visitorId, overrides = {}) {
  return {
    articleId,
    eventType,
    visitorId,
    sessionId: overrides.sessionId || `${visitorId}-session`,
    source: overrides.source || 'homepage',
    language: overrides.language || 'en',
    readTimeSec: overrides.readTimeSec ?? null,
    createdAt: overrides.createdAt || new Date('2026-09-10T10:00:00.000Z'),
  };
}

function makeQuery(values) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => values,
  };
}

function matchesFilter(doc, filter = {}) {
  if (filter.$and && !filter.$and.every((clause) => matchesFilter(doc, clause))) return false;
  if (filter.$or && !filter.$or.some((clause) => matchesFilter(doc, clause))) return false;
  if (filter.status && typeof filter.status === 'object') {
    if (filter.status.$ne !== undefined && doc.status === filter.status.$ne) return false;
    if (filter.status.$exists === false && doc.status !== undefined) return false;
  } else if (filter.status && doc.status !== filter.status) return false;
  if (filter.deletedAt === null && doc.deletedAt !== null && doc.deletedAt !== undefined) return false;
  if (filter.deletedAt && filter.deletedAt.$exists === false && doc.deletedAt !== undefined) return false;
  if (filter.category && doc.category !== filter.category) return false;
  if (filter.language && doc.language !== filter.language) return false;
  if (filter._id && filter._id.$in) {
    const ids = new Set(filter._id.$in.map((id) => String(id)));
    if (!ids.has(String(doc._id))) return false;
  }
  return true;
}

function eventMatches(eventDoc, match = {}) {
  if (typeof match.eventType === 'string' && eventDoc.eventType !== match.eventType) return false;
  if (match.eventType && match.eventType.$in && !match.eventType.$in.includes(eventDoc.eventType)) return false;
  if (match.articleId && match.articleId.$in) {
    const ids = new Set(match.articleId.$in.map((id) => String(id)));
    if (!ids.has(String(eventDoc.articleId))) return false;
  }
  if (match.createdAt) {
    if (match.createdAt.$gte && eventDoc.createdAt.getTime() < match.createdAt.$gte.getTime()) return false;
    if (match.createdAt.$lte && eventDoc.createdAt.getTime() > match.createdAt.$lte.getTime()) return false;
  }
  return true;
}

function metricForEvents(rows, id = null) {
  const viewEvents = rows.filter((row) => row.eventType === 'view');
  const visitorIds = Array.from(new Set(viewEvents.map((row) => row.visitorId).filter(Boolean)));
  const views = viewEvents.length;
  const engagedReads = rows.filter((row) => row.eventType === 'engaged_read').length;
  const totalReadTimeSec = rows
    .filter((row) => row.eventType === 'heartbeat')
    .reduce((sum, row) => sum + Number(row.readTimeSec || 0), 0);
  const scroll100Count = rows.filter((row) => row.eventType === 'scroll_100').length;
  return {
    ...(id ? { articleId: id, _id: id } : {}),
    views,
    visitorIds,
    uniqueReaders: visitorIds.length,
    engagedReads,
    totalReadTimeSec,
    scroll100Count,
    avgReadTimeSec: views > 0 ? totalReadTimeSec / views : 0,
    completionRate: views > 0 ? scroll100Count / views : 0,
    slug: null,
    category: null,
    language: null,
  };
}

function aggregateEvents(events) {
  return async (pipeline) => {
    const match = pipeline.find((stage) => stage.$match)?.$match || {};
    const rows = events.filter((row) => eventMatches(row, match));
    const groupStage = pipeline.find((stage) => stage.$group)?.$group || {};
    const groupId = groupStage._id;

    if (groupId === null) {
      return rows.length ? [metricForEvents(rows)] : [];
    }

    if (groupId === '$articleId') {
      const byArticle = new Map();
      for (const row of rows) {
        const key = String(row.articleId);
        const current = byArticle.get(key) || [];
        current.push(row);
        byArticle.set(key, current);
      }
      return Array.from(byArticle.entries())
        .map(([id, articleEvents]) => metricForEvents(articleEvents, id))
        .sort((a, b) => b.views - a.views);
    }

    const ifNull = groupId && groupId.$ifNull;
    const field = Array.isArray(ifNull) ? String(ifNull[0] || '').replace(/^\$/, '') : null;
    if (field === 'source' || field === 'language') {
      const counts = new Map();
      for (const row of rows) {
        const key = row[field] || 'unknown';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return Array.from(counts.entries())
        .map(([_id, count]) => ({ _id, count }))
        .sort((a, b) => b.count - a.count);
    }

    return [];
  };
}

function countEvents(events) {
  return async (filter) => events.filter((row) => eventMatches(row, filter)).length;
}

function installAnalyticsStubs(t, articles, events) {
  stubReadyState(t);
  stubMethod(t, ArticleAnalyticsEvent, 'aggregate', aggregateEvents(events));
  stubMethod(t, ArticleAnalyticsEvent, 'countDocuments', countEvents(events));
  stubMethod(t, Article, 'find', (filter) => makeQuery(articles.filter((doc) => matchesFilter(doc, filter))));
}

function assertNoPrivateIds(body) {
  const raw = JSON.stringify(body);
  for (const value of ['reader-a', 'reader-b', 'session-private', 'visitorId', 'sessionId', 'ipHash', 'userAgentHash']) {
    assert.equal(raw.includes(value), false, `response leaked ${value}`);
  }
}

const regionalId = '507f1f77bcf86cd799439101';
const businessId = '507f1f77bcf86cd799439102';
const gujaratiId = '507f1f77bcf86cd799439103';

test('one reader and one article view reports one view and one unique reader', async (t) => {
  installAnalyticsStubs(t, [article(regionalId, { category: 'regional', language: 'en' })], [
    event(regionalId, 'view', 'reader-a'),
  ]);

  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const articles = await auth(request(app()).get('/api/admin/analytics/articles'));

  assert.equal(dashboard.body.data.totalViews, 1);
  assert.equal(dashboard.body.data.uniqueVisitors, 1);
  assert.equal(articles.body.items[0].views, 1);
  assert.equal(articles.body.items[0].readers, 1);
});

test('same reader opens two articles across categories and dedupes overall only once', async (t) => {
  installAnalyticsStubs(t, [
    article(regionalId, { category: 'regional', language: 'en' }),
    article(businessId, { category: 'business', language: 'hi' }),
  ], [
    event(regionalId, 'view', 'reader-a', { language: 'en' }),
    event(businessId, 'view', 'reader-a', { language: 'hi' }),
  ]);

  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const categories = await auth(request(app()).get('/api/admin/analytics/categories'));

  assert.equal(dashboard.body.data.totalViews, 2);
  assert.equal(dashboard.body.data.uniqueVisitors, 1);
  const byCategory = new Map(categories.body.items.map((item) => [item.category, item]));
  assert.equal(byCategory.get('regional').views, 1);
  assert.equal(byCategory.get('regional').readers, 1);
  assert.equal(byCategory.get('business').views, 1);
  assert.equal(byCategory.get('business').readers, 1);
});

test('two different readers on one article count as two article and overall readers', async (t) => {
  installAnalyticsStubs(t, [article(regionalId, { category: 'regional', language: 'en' })], [
    event(regionalId, 'view', 'reader-a'),
    event(regionalId, 'view', 'reader-b'),
  ]);

  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const articles = await auth(request(app()).get('/api/admin/analytics/articles'));

  assert.equal(dashboard.body.data.totalViews, 2);
  assert.equal(dashboard.body.data.uniqueReaders, 2);
  assert.equal(articles.body.items[0].views, 2);
  assert.equal(articles.body.items[0].readers, 2);
});

test('repeat stored view does not inflate unique reader count, while engagement/read-time/completion use real events', async (t) => {
  installAnalyticsStubs(t, [article(regionalId, { category: 'regional', language: 'en' })], [
    event(regionalId, 'view', 'reader-a', { sessionId: 'session-1' }),
    event(regionalId, 'view', 'reader-a', { sessionId: 'session-2' }),
    event(regionalId, 'engaged_read', 'reader-a'),
    event(regionalId, 'heartbeat', 'reader-a', { readTimeSec: 40 }),
    event(regionalId, 'heartbeat', 'reader-a', { readTimeSec: 20 }),
    event(regionalId, 'scroll_100', 'reader-a'),
  ]);

  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const articles = await auth(request(app()).get('/api/admin/analytics/articles'));
  const categories = await auth(request(app()).get('/api/admin/analytics/categories'));
  const row = articles.body.items[0];

  assert.equal(dashboard.body.data.totalViews, 2);
  assert.equal(dashboard.body.data.uniqueVisitors, 1);
  assert.equal(row.views, 2);
  assert.equal(row.readers, 1);
  assert.equal(row.engagedReads, 1);
  assert.equal(row.avgReadTimeSec, 30);
  assert.equal(row.completionRate, 0.5);
  assert.equal(categories.body.items[0].engagedReads, 1);
  assert.equal(categories.body.items[0].avgReadTimeSec, 30);
  assert.equal(categories.body.items[0].completionRate, 0.5);
});

test('article rows return real zero values for published articles without analytics', async (t) => {
  installAnalyticsStubs(t, [
    article(regionalId, { category: 'regional', language: 'en' }),
    article(gujaratiId, { category: 'tech', language: 'gu' }),
  ], [event(regionalId, 'view', 'reader-a')]);

  const res = await auth(request(app()).get('/api/admin/analytics/articles'));
  const byId = new Map(res.body.items.map((item) => [item.articleId, item]));

  assert.equal(byId.get(gujaratiId).views, 0);
  assert.equal(byId.get(gujaratiId).readers, 0);
  assert.equal(byId.get(gujaratiId).engagedReads, 0);
  assert.equal(byId.get(gujaratiId).avgReadTimeSec, 0);
  assert.equal(byId.get(gujaratiId).completionRate, 0);
});

test('active analytics article list excludes deleted rows without destroying historical metrics', async (t) => {
  const deletedId = '507f1f77bcf86cd799439199';
  const archivedId = '507f1f77bcf86cd799439198';
  installAnalyticsStubs(t, [
    article(regionalId, { category: 'regional', language: 'en', status: 'draft', publishedAt: null }),
    article(archivedId, { category: 'regional', language: 'en', status: 'archived' }),
    article(deletedId, { category: 'regional', language: 'en', status: 'deleted', deletedAt: new Date('2026-09-12T00:00:00.000Z') }),
  ], [
    event(regionalId, 'view', 'reader-a'),
    event(archivedId, 'view', 'reader-b'),
    event(deletedId, 'view', 'reader-c'),
  ]);

  const articles = await auth(request(app()).get('/api/admin/analytics/articles?status=all'));
  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const ids = new Set(articles.body.items.map((item) => item.articleId));

  assert.equal(ids.has(regionalId), true);
  assert.equal(ids.has(archivedId), true);
  assert.equal(ids.has(deletedId), false);
  assert.equal(articles.body.total, 2);
  assert.equal(dashboard.body.data.totalViews, 3);
});

test('EN, HI, and GU articles remain supported and date ranges filter by event createdAt', async (t) => {
  installAnalyticsStubs(t, [
    article(regionalId, { category: 'regional', language: 'en' }),
    article(businessId, { category: 'business', language: 'hi' }),
    article(gujaratiId, { category: 'tech', language: 'gu' }),
  ], [
    event(regionalId, 'view', 'reader-a', { language: 'en', createdAt: new Date('2026-09-05T00:00:00Z') }),
    event(businessId, 'view', 'reader-b', { language: 'hi', createdAt: new Date('2026-09-10T00:00:00Z') }),
    event(gujaratiId, 'view', 'reader-c', { language: 'gu', createdAt: new Date('2026-08-01T00:00:00Z') }),
  ]);

  const res = await auth(request(app()).get('/api/admin/analytics/articles?dateFrom=2026-09-01&dateTo=2026-09-30&status=all'));
  const byLanguage = new Map(res.body.items.map((item) => [item.language, item]));

  assert.equal(byLanguage.get('en').views, 1);
  assert.equal(byLanguage.get('hi').views, 1);
  assert.equal(byLanguage.get('gu').views, 0);
  assert.equal(res.body.scope, 'custom');
  assert.equal(res.body.dateRange.semantics, 'rolling createdAt range');
});

test('admin analytics responses do not expose private visitor or session identifiers', async (t) => {
  installAnalyticsStubs(t, [article(regionalId, { category: 'regional', language: 'en' })], [
    event(regionalId, 'view', 'reader-a', { sessionId: 'session-private' }),
    event(regionalId, 'heartbeat', 'reader-a', { sessionId: 'session-private', readTimeSec: 12 }),
  ]);

  const dashboard = await auth(request(app()).get('/api/admin/analytics/dashboard'));
  const articles = await auth(request(app()).get('/api/admin/analytics/articles'));
  const categories = await auth(request(app()).get('/api/admin/analytics/categories'));

  assertNoPrivateIds(dashboard.body);
  assertNoPrivateIds(articles.body);
  assertNoPrivateIds(categories.body);
});

test('existing traffic analytics view count remains actual stored view event count', async (t) => {
  installAnalyticsStubs(t, [article(regionalId, { category: 'regional', language: 'en' })], [
    event(regionalId, 'view', 'reader-a'),
    event(regionalId, 'engaged_read', 'reader-a'),
    event(regionalId, 'heartbeat', 'reader-a', { readTimeSec: 10 }),
    event(regionalId, 'scroll_100', 'reader-a'),
  ]);

  const res = await auth(request(app()).get('/api/admin/analytics/dashboard'));

  assert.equal(res.body.data.totalViews, 1);
  assert.equal(res.body.data.totalEngagedReads, 1);
});