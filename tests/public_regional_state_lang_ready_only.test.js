const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const News = require('../models/News');

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
  const prevFind = News.find;
  const prevCount = News.countDocuments;

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
        description: 'મૂળ સારાંશ',
        content: 'મૂળ સામગ્રી',
        imageURL: 'https://img.example/1.jpg',
        location: { state: 'Gujarat', stateSlug: 'gujarat' },
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

    News.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    News.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/regional/gujarat?lang=en&page=1&limit=20');

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
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);

    // Ensure the filter requires translationStatus.en === 'ready'.
    const andClauses = Array.isArray(capture.query.$and) ? capture.query.$and : [];
    const asJson = JSON.stringify(andClauses);
    assert.ok(asJson.includes('translationStatus.en'));
    assert.ok(asJson.includes('ready'));
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('GET /api/public/regional/:state rejects invalid state (400)', async () => {
  const res = await request(app).get('/api/public/regional/not-a-real-state?lang=gu');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});
