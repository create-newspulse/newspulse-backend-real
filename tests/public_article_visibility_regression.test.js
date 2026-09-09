const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const feedRouter = require('../routes/feed');
const News = require('../models/News');
const PublicArticle = require('../models/Article');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  return `np.${Buffer.from(`${email}:0`, 'utf8').toString('base64')}`;
}

function withDbReady(fn) {
  return async () => {
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    });

    try {
      await fn();
    } finally {
      if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
      else delete mongoose.connection.readyState;
    }
  };
}

function getPathValue(doc, path) {
  return String(path || '').split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, doc);
}

function compareValue(value, expected) {
  if (expected instanceof RegExp) return expected.test(String(value || ''));
  if (expected === null) return value === null || value === undefined;
  if (Array.isArray(value)) return value.some((item) => compareValue(item, expected));
  return String(value) === String(expected);
}

function compareLte(value, expected) {
  if (value === null || value === undefined) return false;
  const left = value instanceof Date ? value.getTime() : new Date(value).getTime();
  const right = expected instanceof Date ? expected.getTime() : new Date(expected).getTime();
  return Number.isFinite(left) && Number.isFinite(right) && left <= right;
}

function matchesFieldCondition(value, condition) {
  if (!condition || typeof condition !== 'object' || condition instanceof RegExp || Array.isArray(condition) || condition instanceof Date) {
    return compareValue(value, condition);
  }

  for (const [op, expected] of Object.entries(condition)) {
    if (op === '$in') {
      if (!Array.isArray(expected) || !expected.some((item) => compareValue(value, item))) return false;
    } else if (op === '$nin') {
      if (Array.isArray(expected) && expected.some((item) => compareValue(value, item))) return false;
    } else if (op === '$ne') {
      if (compareValue(value, expected)) return false;
    } else if (op === '$exists') {
      if ((value !== undefined) !== Boolean(expected)) return false;
    } else if (op === '$lte') {
      if (!compareLte(value, expected)) return false;
    } else if (!compareValue(value && value[op], expected)) {
      return false;
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  const query = filter || {};
  if (Array.isArray(query.$and) && !query.$and.every((clause) => matchesFilter(doc, clause))) return false;
  if (Array.isArray(query.$or) && !query.$or.some((clause) => matchesFilter(doc, clause))) return false;

  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and' || key === '$or') continue;
    if (!matchesFieldCondition(getPathValue(doc, key), condition)) return false;
  }
  return true;
}

function makeFindQuery(items) {
  let rows = Array.isArray(items) ? [...items] : [];
  return {
    select() { return this; },
    sort() { return this; },
    skip(n) { rows = rows.slice(n); return this; },
    limit(n) { rows = rows.slice(0, n); return this; },
    lean: async () => rows,
  };
}

function makeOneQuery(item) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => item || null,
  };
}

function publishedNews(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439301',
    title: overrides.title || 'Published public article',
    description: overrides.description || 'Published summary',
    content: overrides.content || 'Published content body',
    slug: overrides.slug || 'published-public-article',
    slugs: overrides.slugs || { en: overrides.slug || 'published-public-article' },
    category: overrides.category || 'tech',
    status: overrides.status || 'published',
    lang: overrides.lang || 'en',
    language: overrides.language || 'en',
    originalLang: overrides.originalLang || 'en',
    publishedAt: overrides.publishedAt || new Date('2026-01-01T00:00:00.000Z'),
    createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
    translations: overrides.translations || {},
    translationStatus: overrides.translationStatus || {},
    ...overrides,
  };
}

function publishedPublicArticle(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439401',
    title: overrides.title || 'Published public story',
    summary: overrides.summary || 'Published story summary',
    content: overrides.content || 'Published story body',
    slug: overrides.slug || 'published-public-story',
    slugs: overrides.slugs || { en: overrides.slug || 'published-public-story' },
    category: overrides.category || 'tech',
    status: overrides.status || 'published',
    language: overrides.language || 'en',
    originalLang: overrides.originalLang || 'en',
    publishedAt: overrides.publishedAt || new Date('2026-01-01T00:00:00.000Z'),
    createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
    translations: overrides.translations || {},
    translationStatus: overrides.translationStatus || {},
    ...overrides,
  };
}

function stubModels({ news = [], publicArticles = [] }) {
  const originals = {
    newsFind: News.find,
    newsFindOne: News.findOne,
    newsFindById: News.findById,
    newsCountDocuments: News.countDocuments,
    publicFind: PublicArticle.find,
    publicFindOne: PublicArticle.findOne,
    publicFindById: PublicArticle.findById,
    publicCountDocuments: PublicArticle.countDocuments,
  };
  const captured = { newsFind: [], newsFindOne: [], publicFind: [], publicFindOne: [] };

  News.find = (filter) => {
    captured.newsFind.push(filter || {});
    return makeFindQuery(news.filter((doc) => matchesFilter(doc, filter)));
  };
  News.findOne = (filter) => {
    captured.newsFindOne.push(filter || {});
    return makeOneQuery(news.find((doc) => matchesFilter(doc, filter)) || null);
  };
  News.findById = async (id) => news.find((doc) => String(doc._id) === String(id)) || null;
  News.countDocuments = async (filter) => news.filter((doc) => matchesFilter(doc, filter)).length;

  PublicArticle.find = (filter) => {
    captured.publicFind.push(filter || {});
    return makeFindQuery(publicArticles.filter((doc) => matchesFilter(doc, filter)));
  };
  PublicArticle.findOne = (filter) => {
    captured.publicFindOne.push(filter || {});
    return makeOneQuery(publicArticles.find((doc) => matchesFilter(doc, filter)) || null);
  };
  PublicArticle.findById = async (id) => publicArticles.find((doc) => String(doc._id) === String(id)) || null;
  PublicArticle.countDocuments = async (filter) => publicArticles.filter((doc) => matchesFilter(doc, filter)).length;

  return {
    captured,
    restore() {
      News.find = originals.newsFind;
      News.findOne = originals.newsFindOne;
      News.findById = originals.newsFindById;
      News.countDocuments = originals.newsCountDocuments;
      PublicArticle.find = originals.publicFind;
      PublicArticle.findOne = originals.publicFindOne;
      PublicArticle.findById = originals.publicFindById;
      PublicArticle.countDocuments = originals.publicCountDocuments;
    },
  };
}

test('GET /api/public/news returns published articles and excludes draft, scheduled, rejected, private, archived, deleted, and future-dated records', { concurrency: false }, withDbReady(async () => {
  const future = new Date('2999-01-01T00:00:00.000Z');
  const visible = publishedNews({ title: 'Visible published', slug: 'visible-published' });
  const hidden = [
    publishedNews({ title: 'Strategic alliance draft', slug: 'strategic-alliance-draft', status: 'draft' }),
    publishedNews({ title: 'Scheduled hidden', slug: 'scheduled-hidden', status: 'scheduled' }),
    publishedNews({ title: 'Rejected hidden', slug: 'rejected-hidden', status: 'rejected' }),
    publishedNews({ title: 'Archived hidden', slug: 'archived-hidden', status: 'archived' }),
    publishedNews({ title: 'Deleted hidden', slug: 'deleted-hidden', status: 'deleted' }),
    publishedNews({ title: 'Private hidden', slug: 'private-hidden', visibility: 'private' }),
    publishedNews({ title: 'Private flag hidden', slug: 'private-flag-hidden', isPrivate: true }),
    publishedNews({ title: 'Future publish hidden', slug: 'future-publish-hidden', publishAt: future }),
    publishedNews({ title: 'Future scheduled hidden', slug: 'future-scheduled-hidden', scheduledAt: future }),
    publishedNews({ title: 'Future publishedAt hidden', slug: 'future-published-at-hidden', publishedAt: future }),
  ];
  const stubs = stubModels({ news: [visible, ...hidden] });

  try {
    const res = await request(app).get('/api/public/news?lang=en&limit=20');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((item) => item.slug), ['visible-published']);
    assert.ok(JSON.stringify(stubs.captured.newsFind[0]).includes('published'));
    assert.equal(stubs.captured.newsFind[0].$and.some((clause) => clause.status === 'published'), true);
  } finally {
    stubs.restore();
  }
}));

test('GET /api/public/news/:slug cannot retrieve a draft News record or draft public Article fallback', { concurrency: false }, withDbReady(async () => {
  const stubs = stubModels({
    news: [publishedNews({ slug: 'draft-detail', status: 'draft' })],
    publicArticles: [publishedPublicArticle({ slug: 'draft-detail', status: 'draft' })],
  });

  try {
    const res = await request(app).get('/api/public/news/draft-detail?lang=en');

    assert.equal(res.status, 404);
    assert.equal(stubs.captured.newsFindOne[0].$and.some((clause) => clause.status === 'published'), true);
    assert.equal(stubs.captured.publicFindOne[0].$and.some((clause) => clause.status === 'published'), true);
  } finally {
    stubs.restore();
  }
}));

test('category feeds do not expose a draft multilingual sibling from a published group', { concurrency: false }, withDbReady(async () => {
  const groupKey = 'visibility-group-1';
  const en = publishedNews({
    _id: '507f1f77bcf86cd799439311',
    title: 'English group story',
    slug: 'english-group-story',
    category: 'tech',
    translationKey: groupKey,
    translationGroupId: groupKey,
    originalLang: 'en',
    lang: 'en',
    language: 'en',
  });
  const hiDraft = publishedNews({
    _id: '507f1f77bcf86cd799439312',
    title: 'Hindi draft group story',
    slug: 'hindi-draft-group-story',
    category: '',
    status: 'draft',
    translationKey: groupKey,
    translationGroupId: groupKey,
    originalLang: 'hi',
    lang: 'hi',
    language: 'hi',
  });
  const stubs = stubModels({ news: [en, hiDraft] });

  try {
    const res = await request(app).get('/api/public/news?category=science-technology&lang=hi&limit=10');

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].title, 'English group story');
    assert.notEqual(res.body.items[0].title, 'Hindi draft group story');
    assert.equal(stubs.captured.newsFind.every((filter) => filter.$and.some((clause) => clause.status === 'published')), true);
  } finally {
    stubs.restore();
  }
}));

test('public Article category and story feeds exclude draft public copies at query time', { concurrency: false }, withDbReady(async () => {
  const visible = publishedPublicArticle({ title: 'Visible story', slug: 'visible-story' });
  const hiddenDraft = publishedPublicArticle({ title: 'Draft story', slug: 'draft-story', status: 'draft' });
  const stubs = stubModels({ publicArticles: [visible, hiddenDraft] });

  try {
    const listRes = await request(app).get('/api/public/stories?category=science-technology&lang=en&limit=10');
    assert.equal(listRes.status, 200);
    assert.deepEqual(listRes.body.data.map((item) => item.slug), ['visible-story']);

    const draftSlugRes = await request(app).get('/api/public/stories/draft-story?lang=en');
    assert.equal(draftSlugRes.status, 404);
    assert.equal(stubs.captured.publicFind.every((filter) => filter.$and.some((clause) => clause.status === 'published')), true);
    assert.equal(stubs.captured.publicFindOne.every((filter) => filter.$and.some((clause) => clause.status === 'published')), true);
  } finally {
    stubs.restore();
  }
}));

test('anonymous compatibility article-by-slug and id routes hide drafts, but authenticated admin detail can retrieve a draft', { concurrency: false }, withDbReady(async () => {
  const draftId = '507f1f77bcf86cd799439321';
  const draft = publishedNews({ _id: draftId, title: 'Admin draft', slug: 'admin-draft', status: 'draft' });
  const stubs = stubModels({ news: [draft] });

  try {
    const publicSlugRes = await request(app).get('/api/articles/slug/admin-draft?lang=en');
    assert.equal(publicSlugRes.status, 200);
    assert.deepEqual(publicSlugRes.body, { exists: false });

    const publicIdRes = await request(app).get(`/api/articles/${draftId}?lang=en`);
    assert.equal(publicIdRes.status, 404);

    const adminDetailRes = await request(app)
      .get(`/api/articles/${draftId}?lang=en`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);
    assert.equal(adminDetailRes.status, 200);
    assert.equal(adminDetailRes.body.article.status, 'draft');
  } finally {
    stubs.restore();
  }
}));

test('authenticated admin article list can still retrieve drafts by status', { concurrency: false }, withDbReady(async () => {
  const draft = publishedNews({ _id: '507f1f77bcf86cd799439331', title: 'Listed draft', slug: 'listed-draft', status: 'draft' });
  const stubs = stubModels({ news: [draft] });

  try {
    const res = await request(app)
      .get('/api/articles?status=draft&limit=10')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].status, 'draft');
  } finally {
    stubs.restore();
  }
}));

test('homepage for-you feed uses the canonical public News visibility filter', { concurrency: false }, withDbReady(async () => {
  const homepageApp = express();
  homepageApp.use('/api/feed', feedRouter);
  const visible = publishedNews({ title: 'Homepage published', slug: 'homepage-published' });
  const hidden = publishedNews({ title: 'Homepage draft', slug: 'homepage-draft', status: 'draft' });
  const stubs = stubModels({ news: [visible, hidden] });

  try {
    const res = await request(homepageApp).get('/api/feed/for-you?language=en&limit=15');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.items.map((item) => item.title), ['Homepage published']);
    assert.equal(stubs.captured.newsFind[0].$and.some((clause) => clause.status === 'published'), true);
  } finally {
    stubs.restore();
  }
}));