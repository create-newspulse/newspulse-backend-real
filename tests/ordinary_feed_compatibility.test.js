const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { listPublicStories } = require('../services/ordinaryPublicNews.service');
const { localizeArticleForLang } = require('../services/mapArticleForLang');
const { installFeedModels, publishedNews, publishedArticleForNews, bucket } = require('./helpers/publicFeedModels');

function ready(t) {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previous; });
}

function assertKeysPreserved(before, after, path = 'item') {
  for (const key of Object.keys(before)) {
    assert.ok(Object.hasOwn(after, key), `Missing legacy key ${path}.${key}`);
    if (before[key] && typeof before[key] === 'object' && !Array.isArray(before[key])) {
      assert.ok(after[key] && typeof after[key] === 'object', `Changed legacy shape ${path}.${key}`);
      assertKeysPreserved(before[key], after[key], `${path}.${key}`);
    }
  }
}

function contractNews() {
  return publishedNews(1, {
    sourceLabel: 'News desk', stateTags: ['gujarat'], stateNames: ['Gujarat'],
    state: 'Gujarat', district: 'Ahmedabad', city: 'Ahmedabad',
    location: { state: 'Gujarat', district: 'Ahmedabad', city: 'Ahmedabad' },
    geo: { state: 'gujarat', district: 'ahmedabad', city: 'ahmedabad', country: 'India' },
    slugs: { gu: 'story-gu', hi: 'story-hi', en: 'story-en' },
    translations: { hi: bucket('hi'), en: bucket('en') },
    translationStatus: { hi: 'ready', en: 'ready' },
    translationError: { hi: null }, translationUpdatedAt: { hi: new Date('2026-01-02') },
    i18n: { title: { hi: 'hi title' }, summary: { hi: 'hi summary' }, content: { hi: 'hi body' } },
    coverImage: { url: 'https://example.test/news.jpg', alt: 'News image' },
    imageAlt: 'News image', tags: ['state:gujarat'], readMinutes: 7,
    authorByline: { enabled: true, snapshot: { name: 'Public author', shortBio: 'Public biography' } },
  });
}

for (const endpoint of [
  { path: '/api/public/news', items: (body) => body.items },
  { path: '/api/public/articles', items: (body) => body.data.items },
  { path: '/api/public/stories', items: (body) => body.data },
]) {
  test(`${endpoint.path} preserves the legacy item's keys and translation metadata`, async (t) => {
    ready(t);
    const news = contractNews();
    const copy = publishedArticleForNews(news, {
      slug: 'public-story', slugs: { gu: 'public-gu', hi: 'public-hi', en: 'public-en' },
      coverImage: { url: 'https://example.test/public.jpg', alt: 'Public image' },
      authorByline: { enabled: false }, createdAt: new Date('2025-12-01'),
    });
    installFeedModels(t, { news: [news], copies: [copy] });
    const legacy = await request(app).get(`${endpoint.path}?lang=gu`);
    const ordinary = await request(app).get(`${endpoint.path}?category=regional&lang=gu`);
    assert.equal(legacy.status, 200);
    assert.equal(ordinary.status, 200);
    const before = endpoint.items(legacy.body)[0];
    const after = endpoint.items(ordinary.body)[0];
    assert.ok(before);
    assert.ok(after);
    assertKeysPreserved(before, after);
    assert.equal(after._id, before._id);
    const legacyCategorySlug = endpoint.path === '/api/public/stories'
      ? localizeArticleForLang(copy, 'gu', { fallbackToBase: true }).slug : before.slug;
    assert.equal(after.slug, legacyCategorySlug);
    assert.deepEqual(after.authorByline, before.authorByline);
    if (endpoint.path === '/api/public/news') {
      assert.deepEqual(after.translationAvailability.translations, before.translationAvailability.translations);
      assert.equal(after.isFallback, false);
    } else {
      for (const field of ['translations', 'translationStatus', 'i18n', 'location']) {
        assert.deepEqual(after[field], before[field], field);
      }
      assert.equal(after.geo.country, 'India');
    }
  });
}

test('Regional retains every legacy item key and National/state retains News metadata', async (t) => {
  ready(t);
  const regional = contractNews();
  const national = publishedNews(2, { ...regional, _id: publishedNews(2)._id, slug: 'national-story', category: 'national' });
  const copy = publishedArticleForNews(regional);
  installFeedModels(t, { news: [regional, national], copies: [copy] });
  const regionalResponse = await request(app).get('/api/public/regional?state=gujarat&lang=gu');
  assert.equal(regionalResponse.status, 200);
  const regionalItem = regionalResponse.body.data.items[0];
  for (const key of ['_id', 'slug', 'canonicalSlug', 'slugs', 'category', 'stateSlug', 'imageUrl',
    'title', 'summary', 'content', 'generatedAt', 'provider', 'authorByline']) {
    assert.ok(Object.hasOwn(regionalItem, key), key);
  }
  assert.equal(regionalItem._id, copy._id);
  assert.equal(regionalItem.slug, copy.slug);
  const legacy = await request(app).get('/api/public/articles?lang=gu');
  const expected = legacy.body.data.items.find((item) => item._id === national._id);
  const response = await request(app).get('/api/articles/national/state/gujarat?lang=gu');
  assert.equal(response.status, 200);
  assertKeysPreserved(expected, response.body.data.items[0]);
  assert.deepEqual(response.body.data.items[0].translations, expected.translations);
  assert.deepEqual(response.body.data.items[0].translationStatus, expected.translationStatus);
});

test('legacy stories require a visible, language-resolvable public identity before final pagination', async (t) => {
  ready(t);
  const docs = Array.from({ length: 35 }, (_, index) => publishedNews(index + 1, {
    translations: { hi: bucket('hi') }, translationStatus: { hi: 'ready' },
  }));
  const copies = docs.slice(1).map((doc) => publishedArticleForNews(doc, {
    slug: `public-${doc.slug}`, slugs: { hi: `public-hi-${doc.slug}` },
    createdAt: new Date('2025-12-01'),
  }));
  copies[0].status = 'draft';
  copies[1].translationStatus = { hi: 'pending' };
  copies[2].translations = { hi: bucket('hi', { summary: '' }) };
  installFeedModels(t, { news: docs, copies });
  const writes = t.mock.method(PublicArticle, 'findOneAndUpdate', async () => { throw new Error('GET must not create projections'); });
  const first = await request(app).get('/api/public/stories?category=regional&lang=hi&limit=30');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 31);
  assert.equal(first.body.data.length, 30);
  assert.equal(first.body.hasMore, true);
  for (const item of first.body.data) {
    const copy = copies.find((entry) => entry._id === item._id);
    assert.ok(copy);
    assert.equal(item.id, copy._id);
    assert.equal(item.createdAt, copy.createdAt.toISOString());
    assert.equal(item.slug, copy.slugs.hi);
    const detail = await request(app).get(`/api/public/stories/${encodeURIComponent(item.slug)}?lang=hi`);
    assert.equal(detail.status, 200, item.slug);
    assert.equal(detail.body.data._id, item._id);
    assert.equal(detail.body.data.title, item.title);
  }
  const second = await request(app).get('/api/public/stories?category=regional&lang=hi&limit=30&page=2');
  assert.equal(second.body.data.length, 1);
  assert.equal(second.body.hasMore, false);
  const newsResponse = await request(app).get('/api/public/news?category=regional&lang=hi&limit=100');
  assert.equal(newsResponse.body.total, 35);
  assert.equal(writes.mock.callCount(), 0);
});

const protectedOrigins = [
  { communityReportId: '000000000000000000000090' },
  { sourceType: 'Youth Pulse' },
  { sourceTrack: 'campus-buzz' },
  { originType: 'inspiration-hub' },
  { submissionSource: 'Pulse Dialogue' },
  { pulseDialogue: { contributorId: '000000000000000000000091' } },
];

test('protected Regional origins and their descendants cannot enter ordinary resolution', async (t) => {
  const ordinary = publishedNews(1);
  const protectedDocs = protectedOrigins.map((origin, index) => publishedNews(index + 10, origin));
  const children = protectedDocs.map((parent, index) => publishedNews(index + 20, { sourceArticleId: parent._id }));
  const grandchildren = children.map((parent, index) => publishedNews(index + 30, { sourceArticleId: parent._id }));
  installFeedModels(t, { news: [ordinary, ...protectedDocs, ...children, ...grandchildren] });
  const result = await listPublicStories({ category: 'regional', lang: 'gu' });
  assert.deepEqual(result.items.map((item) => item._id), [ordinary._id]);
});

test('protected group metadata cannot take ownership of an otherwise ordinary story', async (t) => {
  const ordinary = publishedNews(1, { translationKey: 'shared-key' });
  const protectedDoc = publishedNews(2, {
    translationKey: 'shared-key', sourceLanguage: 'en', originalLang: 'en', language: 'en', lang: 'en',
    source: 'inspiration_hub',
  });
  installFeedModels(t, { news: [ordinary, protectedDoc] });
  assert.equal((await listPublicStories({ category: 'regional', lang: 'gu' })).total, 1);
  assert.equal((await listPublicStories({ category: 'regional', lang: 'en' })).total, 0);
});

test('origin exclusions do not remove protected content from category-less legacy public paths', async (t) => {
  ready(t);
  const docs = [publishedNews(1), ...protectedOrigins.map((origin, index) => publishedNews(index + 2, origin))];
  installFeedModels(t, { news: docs, copies: docs.map((doc) => publishedArticleForNews(doc)) });
  for (const endpoint of [
    { path: '/api/public/news', items: (body) => body.items },
    { path: '/api/public/articles', items: (body) => body.data.items },
    { path: '/api/public/stories', items: (body) => body.data },
  ]) {
    const ordinary = await request(app).get(`${endpoint.path}?category=regional&lang=gu`);
    assert.equal(ordinary.status, 200);
    assert.equal(endpoint.items(ordinary.body).length, 1);
    const legacy = await request(app).get(`${endpoint.path}?lang=gu`);
    assert.equal(legacy.status, 200);
    assert.equal(endpoint.items(legacy.body).length, docs.length);
  }
});

test('ordinary database-unavailable responses retain the exact legacy HTTP 200 envelopes', async (t) => {
  const previousState = mongoose.connection.readyState;
  const previousEnvironment = process.env.NODE_ENV;
  mongoose.connection.readyState = 0;
  process.env.NODE_ENV = 'development';
  t.after(() => {
    mongoose.connection.readyState = previousState;
    process.env.NODE_ENV = previousEnvironment;
  });
  const newsQueries = t.mock.method(News, 'find', () => { throw new Error('Unavailable database must not be queried'); });
  const publicQueries = t.mock.method(PublicArticle, 'find', () => { throw new Error('Unavailable database must not be queried'); });
  for (const category of ['', 'regional', 'national']) {
    const query = category ? `?category=${category}` : '';
    const news = await request(app).get(`/api/public/news${query}`);
    assert.equal(news.status, 200);
    assert.deepEqual(news.body, { items: [], page: 1, limit: 30, total: 0, totalPages: 1 });
    const stories = await request(app).get(`/api/public/stories${query}`);
    assert.equal(stories.status, 200);
    assert.deepEqual(stories.body, { success: true, data: [], message: 'Database unavailable' });
  }
  assert.equal(newsQueries.mock.callCount(), 0);
  assert.equal(publicQueries.mock.callCount(), 0);
});
