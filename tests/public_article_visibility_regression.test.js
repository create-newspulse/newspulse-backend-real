require('./helpers/publicNewsIsolation');
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
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { accountAuthFixture } = require('./helpers/accountAuthFixture');
const { matches: matchesAggregateFilter } = require('./helpers/pulseDialogueAggregate');
const { localizeArticleForLang } = require('../services/mapArticleForLang');

function makeOpaqueAdminToken(email = 'admin@example.invalid') {
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
    } else if (op === '$not') {
      if (matchesFieldCondition(value, expected)) return false;
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
  if (Array.isArray(query.$nor) && query.$nor.some((clause) => matchesFilter(doc, clause))) return false;
  if ('$expr' in query && !matchesAggregateFilter(doc, { $expr: query.$expr })) return false;

  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and' || key === '$or' || key === '$nor' || key === '$expr') continue;
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
  const captured = { newsFind: [], newsFindOne: [], publicFind: [], publicFindOne: [], publicCount: [] };

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
  PublicArticle.countDocuments = async (filter) => {
    captured.publicCount.push(filter || {});
    return publicArticles.filter((doc) => matchesFilter(doc, filter)).length;
  };

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

test('synchronized Gujarat copies pass the unchanged Regional query without admitting ineligible sources', { concurrency: false }, withDbReady(async () => {
  const originalUpsert = PublicArticle.findOneAndUpdate;
  const copies = [];
  const sources = [
    { location: { state: 'Gujarat', stateSlug: null } },
    { location: { state: null, stateSlug: 'gujarat' } },
    { location: null, state: 'Gujarat' },
    { location: { state: 'Maharashtra' } },
    { location: null, title: 'Gujarat headline without geographic metadata', stateTags: ['gujarat'] },
    { location: { state: 'Gujarat' }, status: 'draft' },
    { location: { state: 'Gujarat' }, translationStatus: { en: 'pending' } },
    { location: { state: 'Gujarat' }, translations: { en: { title: 'Incomplete', summary: '', content: '' } } },
    { location: { state: 'Gujarat' }, category: 'national' },
    { status: 'archived' },
    { visibility: 'private' },
    { publishedAt: new Date('2999-01-01T00:00:00.000Z') },
  ];
  PublicArticle.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      const copy = { _id: update.$set.sourceNewsId, ...update.$setOnInsert, ...update.$set };
      copies.push(copy);
      return copy;
    },
  });
  let stubs;
  try {
    for (const [index, metadata] of sources.entries()) {
      await syncPublicArticleFromNews({
        _id: `507f1f77bcf86cd7994395${String(index).padStart(2, '0')}`,
        title: 'Source title',
        description: 'Source summary',
        content: '<p>Source body</p>',
        slug: `regional-sync-${index}`,
        category: 'regional',
        status: 'published',
        publishedAt: new Date('2026-01-02T00:00:00.000Z'),
        language: 'gu',
        originalLang: 'gu',
        geo: { state: null, district: null, city: null },
        translations: { en: { title: 'English translation', summary: 'English summary', content: 'English body' } },
        translationStatus: { en: 'ready' },
        ...metadata,
      });
    }
    for (const copy of copies.slice(0, 5)) {
      assert.equal(copy.geo.state, 'gujarat');
      assert.equal(copy.state, 'Gujarat');
      assert.equal(copy.status, 'published');
      assert.equal(copy.translationStatus.en, 'ready');
    }
    const unsynchronizedCopies = [
      publishedPublicArticle({
        _id: '507f1f77bcf86cd799439591',
        slug: 'regional-unsynced-maharashtra',
        category: 'regional',
        geo: { state: 'maharashtra' },
        state: 'Maharashtra',
      }),
      publishedPublicArticle({
        _id: '507f1f77bcf86cd799439592',
        slug: 'regional-unsynced-headline-only',
        title: 'Gujarat headline without geographic metadata',
        category: 'regional',
        stateTags: ['gujarat'],
      }),
    ];
    stubs = stubModels({ publicArticles: [...copies, ...unsynchronizedCopies] });
    const res = await request(app).get('/api/public/regional?state=gujarat&lang=en&limit=30');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.items.map((item) => item.slug), [
      'regional-sync-0', 'regional-sync-1', 'regional-sync-2', 'regional-sync-3', 'regional-sync-4',
    ]);
    assert.equal(res.body.data.total, 5);
    assert.ok(res.body.data.items.every((item) => item.title === 'English translation'));
    assert.equal(stubs.captured.publicFind[0].category, 'regional');
    assert.deepEqual(stubs.captured.publicCount, stubs.captured.publicFind);
  } finally {
    if (stubs) stubs.restore();
    PublicArticle.findOneAndUpdate = originalUpsert;
  }
}));

for (const lang of ['en', 'hi']) {
  test(`Regional translation eligibility matches ${lang} serialization before counts and paging, preserving native articles`, { concurrency: false }, withDbReady(async () => {
    const bucket = { title: `${lang} title`, summary: `${lang} summary`, content: `${lang} body` };
    let nextId = 600;
    const article = (suffix, overrides = {}) => publishedPublicArticle({
      _id: (nextId++).toString(16).padStart(24, '0'),
      slug: `regional-${lang}-${suffix}`,
      category: 'regional', geo: { state: 'gujarat' },
      language: 'gu', originalLang: 'gu',
      translations: { [lang]: bucket }, translationStatus: { [lang]: 'ready' },
      ...overrides,
    });
    const whitespace = '\t\n\v\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
      + '\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
    const invalidValues = [undefined, null, '', ...whitespace, 0, 42, false, {}, [], ['text']];
    const incomplete = ['title', 'summary', 'content'].flatMap(field => invalidValues.map((value, index) => {
      const doc = article(`${field}-${index}`, { translations: { [lang]: { ...bucket, [field]: value } } });
      assert.equal(localizeArticleForLang(doc, lang, { fallbackToBase: false }), null);
      return doc;
    }));
    const native = article('native', {
      language: lang, originalLang: lang,
      translations: { [lang]: { title: null, summary: null, content: null } },
      translationStatus: { [lang]: 'pending' },
    });
    const eligible = [
      native,
      article('translated'),
      article('padded', { translations: { [lang]: {
        title: `\uFEFF ${lang} title \u00A0`, summary: `\t${lang} summary\r\n`, content: `${lang} body`,
      } } }),
      article('non-whitespace', { translations: { [lang]: { title: '\u0000', summary: '\u200B', content: '\u180E' } } }),
    ];
    for (const doc of eligible) assert.ok(localizeArticleForLang(doc, lang, { fallbackToBase: false }));
    const future = new Date('2999-01-01T00:00:00.000Z');
    const hidden = [
      { status: 'draft' }, { status: 'archived' }, { status: 'deleted' }, { deletedAt: new Date() },
      { visibility: 'private' }, { isPrivate: true }, { publishedAt: future }, { publishAt: future },
      { scheduledAt: future }, { locked: true }, { embargoUntil: future },
      { category: 'national' }, { geo: { state: 'maharashtra' }, state: 'Maharashtra' }, { geo: null },
      { translationStatus: { [lang]: 'pending' } }, { translationStatus: { [lang]: 'failed' } },
    ].map((overrides, index) => article(`hidden-${index}`, overrides));
    const stubs = stubModels({ publicArticles: [...incomplete, ...hidden, ...eligible] });
    try {
      const items = [];
      for (const page of [1, 2]) {
        const res = await request(app).get(`/api/public/regional?state=gujarat&lang=${lang}&page=${page}&limit=2`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.page, page);
        assert.equal(res.body.data.limit, 2);
        assert.equal(res.body.data.total, 4);
        assert.equal(res.body.data.items.length, 2);
        items.push(...res.body.data.items);
      }
      assert.deepEqual(items.map(item => item.slug), eligible.map(doc => doc.slug));
      assert.equal(items[0].title, native.title);
      assert.deepEqual(stubs.captured.publicFind, stubs.captured.publicCount);
      assert.doesNotThrow(() => PublicArticle.where(stubs.captured.publicFind[0]).cast(PublicArticle));
    } finally {
      stubs.restore();
    }
  }));
}

test('Regional translation eligibility preserves Gujarati fallback without adding Hindi fallback', { concurrency: false }, withDbReady(async () => {
  const nativeEnglish = publishedPublicArticle({
    slug: 'regional-native-english', category: 'regional', geo: { state: 'gujarat' },
    language: 'en', originalLang: 'en', translations: {}, translationStatus: {},
  });
  const stubs = stubModels({ publicArticles: [nativeEnglish] });
  try {
    const gu = await request(app).get('/api/public/regional/gujarat?lang=gu');
    assert.equal(gu.status, 200);
    assert.equal(gu.body.data.total, 1);
    assert.equal(gu.body.data.items[0].title, nativeEnglish.title);
    const hi = await request(app).get('/api/public/regional?state=gujarat&lang=hi');
    assert.equal(hi.status, 200);
    assert.equal(hi.body.data.total, 0);
    assert.deepEqual(hi.body.data.items, []);
  } finally {
    stubs.restore();
  }
}));

test('Regional translation eligibility leaves unrelated public article predicates unchanged', { concurrency: false }, withDbReady(async () => {
  const native = publishedNews({ slug: 'ordinary-native' });
  const stubs = stubModels({ news: [native] });
  try {
    const res = await request(app).get('/api/public/articles?lang=en&limit=2');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
    assert.equal(res.body.data.items[0].slug, native.slug);
    const query = stubs.captured.newsFind[0];
    assert.equal(JSON.stringify(query).includes('$expr'), false);
    const localeClause = query.$and.find(clause => clause.$or?.some(branch => (
      branch.$and?.some(term => term['translationStatus.en'] === 'ready')
    )));
    assert.ok(localeClause);
    assert.deepEqual(localeClause.$or[1].$and.slice(1), ['title', 'summary', 'content'].map(field => ({
      [`translations.en.${field}`]: { $exists: true, $ne: '' },
    })));
  } finally {
    stubs.restore();
  }
}));

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

test('anonymous compatibility article-by-slug and id routes hide drafts, but authenticated admin detail can retrieve a draft', { concurrency: false }, async (t) => {
  const auth = accountAuthFixture();
  auth.install(t);
  const adminToken = auth.token('admin');
  const draftId = '507f1f77bcf86cd799439321';
  const draft = publishedNews({ _id: draftId, title: 'Admin draft', slug: 'admin-draft', status: 'draft' });
  const stubs = stubModels({ news: [draft] });

  try {
    const publicSlugRes = await request(app).get('/api/articles/slug/admin-draft?lang=en');
    assert.equal(publicSlugRes.status, 200);
    assert.deepEqual(publicSlugRes.body, { exists: false });

    const publicIdRes = await request(app).get(`/api/articles/${draftId}?lang=en`);
    assert.equal(publicIdRes.status, 404);

    const invalidDetailRes = await request(app)
      .get(`/api/articles/${draftId}?lang=en`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);
    assert.equal(invalidDetailRes.status, 404);

    const adminDetailRes = await request(app)
      .get(`/api/articles/${draftId}?lang=en`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(adminDetailRes.status, 200);
    assert.equal(adminDetailRes.body.article._id, draftId);
    assert.equal(adminDetailRes.body.article.status, 'draft');
  } finally {
    stubs.restore();
  }
});

test('authenticated admin article list can still retrieve drafts by status', { concurrency: false }, async (t) => {
  const auth = accountAuthFixture();
  auth.install(t);
  const adminToken = auth.token('admin');
  const draft = publishedNews({ _id: '507f1f77bcf86cd799439331', title: 'Listed draft', slug: 'listed-draft', status: 'draft' });
  const stubs = stubModels({ news: [draft] });

  try {
    const anonymousRes = await request(app).get('/api/articles?status=draft&limit=10');
    assert.equal(anonymousRes.status, 401);

    const invalidRes = await request(app)
      .get('/api/articles?status=draft&limit=10')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);
    assert.equal(invalidRes.status, 401);
    assert.equal(stubs.captured.newsFind.length, 0);

    const res = await request(app)
      .get('/api/articles?status=draft&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0]._id, draft._id);
    assert.equal(res.body.items[0].status, 'draft');
  } finally {
    stubs.restore();
  }
});

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