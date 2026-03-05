const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const Article = require('../models/Article');

process.env.NODE_ENV = 'test';
const app = require('../server');

function makeChainableQuery(items, capture) {
  return {
    select(arg) {
      capture.selectArg = arg;
      return this;
    },
    sort(arg) {
      capture.sortArg = arg;
      return this;
    },
    skip(n) {
      capture.skip = n;
      return this;
    },
    limit(n) {
      capture.limit = n;
      return this;
    },
    lean: async () => items,
  };
}

test('GET /api/public/regional/:state?lang=en returns ready-only translations and maps translated fields', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [
      {
        _id: '507f1f77bcf86cd799439011',
        slug: 'gu-1',
        slugs: { gu: 'gu-1', en: 'en-1' },
        category: 'regional',
        originalLang: 'gu',
        title: 'મૂળ શીર્ષક',
        summary: 'મૂળ સારાંશ',
        content: 'મૂળ સામગ્રી',
        coverImage: { url: 'https://img.example/1.jpg', publicId: null, alt: null },
        geo: { state: 'gujarat', district: null, city: null },
        tags: ['state:gujarat'],
        translationStatus: { en: 'ready', hi: 'pending', gu: 'ready' },
        translations: {
          en: {
            title: 'Translated title',
            summary: 'Translated summary',
            content: 'Translated content',
            provider: 'google',
            generatedAt: new Date('2026-03-06T00:00:00.000Z'),
          },
        },
      },
    ];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=gujarat&lang=en&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');
    assert.equal(res.body.data.lang, 'en');
    assert.equal(res.body.data.items.length, 1);

    const item = res.body.data.items[0];
    assert.equal(item.slug, 'gu-1');
    assert.equal(item.imageUrl, 'https://img.example/1.jpg');
    assert.equal(item.title, 'Translated title');
    assert.equal(item.summary, 'Translated summary');
    assert.equal(item.content, 'Translated content');
    assert.equal(item.provider, 'google');
    assert.equal(new Date(item.generatedAt).toISOString(), '2026-03-06T00:00:00.000Z');

    // Query should include ready-only translation match for the requested lang.
    assert.ok(capture.query);
    assert.equal(capture.query.status, 'published');
    assert.equal(capture.query.category, 'regional');
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);

    // Ensure the filter requires translationStatus.en === 'ready'.
    const andClauses = Array.isArray(capture.query.$and) ? capture.query.$and : [];
    const asJson = JSON.stringify(andClauses);
    // Ensure state clause matches geo.state OR state:<slug> tag
    assert.ok(asJson.includes('geo.state'));
    assert.ok(asJson.toLowerCase().includes('state'));
    assert.ok(asJson.includes('translationStatus.en'));
    assert.ok(asJson.includes('ready'));
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional supports district + city filters via geo+tag fallback', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=Gujarat%20&district=Ahmedabad%20&city=Gandhinagar&lang=gu&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');

    assert.ok(capture.query);
    const andClauses = Array.isArray(capture.query.$and) ? capture.query.$and : [];
    const asJson = JSON.stringify(andClauses).toLowerCase();
    assert.ok(asJson.includes('geo.state'));
    assert.ok(asJson.includes('geo.district'));
    assert.ok(asJson.includes('geo.city'));

    // District and city are matched independently (strict).
    const districtClause = andClauses.find((c) => JSON.stringify(c).toLowerCase().includes('geo.district'));
    assert.ok(districtClause);
    const districtJson = JSON.stringify(districtClause).toLowerCase();
    assert.ok(districtJson.includes('tags'));
    assert.ok(districtJson.includes('district'));

    const cityClause = andClauses.find((c) => JSON.stringify(c).toLowerCase().includes('geo.city'));
    assert.ok(cityClause);
    const cityJson = JSON.stringify(cityClause).toLowerCase();
    assert.ok(cityJson.includes('tags'));
    assert.ok(cityJson.includes('city'));
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional sanitizes district/city "undefined" strings (state-only query still works)', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=gujarat&district=undefined&city=undefined&lang=gu&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');

    assert.ok(capture.query);
    const andClauses = Array.isArray(capture.query.$and) ? capture.query.$and : [];
    const asJson = JSON.stringify(andClauses).toLowerCase();

    // Should include only the state clause (+ lang clause), not district/city.
    assert.ok(asJson.includes('geo.state'));
    assert.ok(!asJson.includes('geo.district'));
    assert.ok(!asJson.includes('geo.city'));
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional accepts state:/district:/city: prefixed query params', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=state:gujarat&district=district:gandhinagar&city=city:gandhinagar&lang=gu&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');

    assert.ok(capture.query);
    const andClauses = Array.isArray(capture.query.$and) ? capture.query.$and : [];
    const asJson = JSON.stringify(andClauses).toLowerCase();
    assert.ok(asJson.includes('geo.state'));
    assert.ok(asJson.includes('geo.district'));
    assert.ok(asJson.includes('geo.city'));
    // Ensure we didn't accidentally slugify to "state-gujarat"
    assert.ok(!asJson.includes('state-gujarat'));
    assert.ok(!asJson.includes('district-gandhinagar'));
    assert.ok(!asJson.includes('city-gandhinagar'));
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional dedupes items by translationGroupId (prefers original-in-lang)', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [
      {
        _id: '507f1f77bcf86cd799439021',
        slug: 'story-en',
        slugs: { en: 'story-en', gu: 'story-gu' },
        translationGroupId: 'grp-1',
        category: 'regional',
        originalLang: 'en',
        language: 'en',
        title: 'Original English title',
        summary: 'Original English summary',
        content: 'Original English content',
        coverImage: { url: 'https://img.example/1.jpg', publicId: null, alt: null },
        geo: { state: 'gujarat', district: null, city: 'gandhinagar' },
        tags: ['state:gujarat', 'city:gandhinagar'],
        translationStatus: { en: 'ready', hi: 'pending', gu: 'pending' },
        translations: {},
      },
      {
        _id: '507f1f77bcf86cd799439022',
        slug: 'story-gu',
        slugs: { en: 'story-en', gu: 'story-gu' },
        translationGroupId: 'grp-1',
        category: 'regional',
        originalLang: 'gu',
        language: 'gu',
        title: 'મૂળ',
        summary: 'મૂળ',
        content: 'મૂળ',
        coverImage: { url: 'https://img.example/2.jpg', publicId: null, alt: null },
        geo: { state: 'gujarat', district: null, city: 'gandhinagar' },
        tags: ['state:gujarat', 'city:gandhinagar'],
        translationStatus: { en: 'ready', hi: 'pending', gu: 'ready' },
        translations: {
          en: {
            title: 'Translated title',
            summary: 'Translated summary',
            content: 'Translated content',
            provider: 'google',
            generatedAt: new Date('2026-03-06T00:00:00.000Z'),
          },
        },
      },
    ];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=gujarat&city=gandhinagar&lang=en&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.lang, 'en');
    assert.equal(res.body.data.items.length, 1);

    const item = res.body.data.items[0];
    assert.equal(item.slug, 'story-en');
    assert.equal(item.title, 'Original English title');
    assert.equal(item.summary, 'Original English summary');
    assert.equal(item.content, 'Original English content');
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional dedupes items by slugs.en when translationGroupId is missing', async () => {
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  const capture = { query: null, selectArg: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [
      {
        _id: '507f1f77bcf86cd799439031',
        slug: 'gujarati-slug-1',
        slugs: { en: 'final-result-of-unarmed-psi', gu: 'gujarati-slug-1' },
        category: 'regional',
        originalLang: 'gu',
        language: 'gu',
        title: 'મૂળ',
        summary: 'મૂળ',
        content: 'મૂળ',
        geo: { state: 'gujarat', district: 'gandhinagar', city: null },
        tags: ['state:gujarat', 'district:gandhinagar'],
        translationStatus: { en: 'ready' },
        translations: {
          en: { title: 'Translated A', summary: 'Translated A', content: 'Translated A', provider: 'google' },
        },
      },
      {
        _id: '507f1f77bcf86cd799439032',
        slug: 'english-slug-1',
        slugs: { en: 'final-result-of-unarmed-psi', gu: 'gujarati-slug-1' },
        category: 'regional',
        originalLang: 'en',
        language: 'en',
        title: 'Original English',
        summary: 'Original English',
        content: 'Original English',
        geo: { state: 'gujarat', district: 'gandhinagar', city: null },
        tags: ['state:gujarat', 'district:gandhinagar'],
        translationStatus: { en: 'ready' },
        translations: {},
      },
    ];

    Article.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    Article.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional?state=gujarat&district=gandhinagar&lang=en&page=1&limit=20');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.lang, 'en');
    assert.equal(res.body.data.items.length, 1);
    // Prefer original-in-lang
    assert.equal(res.body.data.items[0].slug, 'english-slug-1');
    assert.equal(res.body.data.items[0].title, 'Original English');
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
  }
});

test('GET /api/public/regional/:state rejects invalid state (400)', async () => {
  const res = await request(app).get('/api/public/regional/not-a-real-state?lang=gu');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});
