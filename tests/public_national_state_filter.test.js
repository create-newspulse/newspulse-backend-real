const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const News = require('../models/News');

process.env.NODE_ENV = 'test';
const app = require('../server');

function makeChainableQuery(items, capture) {
  return {
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

test('GET /api/articles/national/state/:stateSlug filters published national by stateTags (200)', async () => {
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  const capture = { query: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [
      { _id: '1', title: 't1', description: 'd', content: 'c', category: 'national', status: 'published', stateTags: ['gujarat'] },
      { _id: '2', title: 't2', description: 'd', content: 'c', category: 'national', status: 'published', stateTags: ['gujarat', 'delhi'] },
    ];

    News.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    News.countDocuments = async (q) => {
      // should match the same query
      assert.deepEqual(q, capture.query);
      return dataset.length;
    };

    const res = await request(app)
      .get('/api/articles/national/state/gujarat?page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');
    assert.equal(res.body.data.total, 2);

    assert.ok(capture.query);
    assert.equal(capture.query.category, 'national');
    assert.equal(capture.query.stateTags, 'gujarat');
    // Shared visibility filter uses $and clauses (published + not deleted/locked/embargo + publishAt safety).
    assert.ok(Array.isArray(capture.query.$and));
    const qJson = JSON.stringify(capture.query).toLowerCase();
    assert.ok(qJson.includes('published'));
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('GET /api/articles/national/state/:stateSlug?lang=en returns ready-only translations and maps translated fields', async () => {
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  const capture = { query: null, sortArg: null, skip: null, limit: null, filtered: null };

  try {
    const dataset = [
      {
        _id: '507f1f77bcf86cd799439011',
        slug: 'gu-1',
        translationGroupId: 'grp-1',
        category: 'national',
        status: 'published',
        stateTags: ['gujarat'],
        originalLang: 'gu',
        lang: 'gu',
        language: 'gu',
        title: 'મૂળ શીર્ષક',
        description: 'મૂળ સારાંશ',
        content: 'મૂળ સામગ્રી',
        translationStatus: { en: 'ready' },
        translations: {
          en: {
            title: 'Translated title',
            summary: 'Translated summary',
            content: 'Translated content',
            provider: null,
            generatedAt: new Date('2026-03-06T00:00:00.000Z'),
          },
        },
      },
      {
        _id: '507f1f77bcf86cd799439013',
        slug: 'en-1',
        translationGroupId: 'grp-1',
        category: 'national',
        status: 'published',
        stateTags: ['gujarat'],
        originalLang: 'en',
        lang: 'en',
        language: 'en',
        title: 'Original English title',
        description: 'Original English summary',
        content: 'Original English content',
        translationStatus: { en: 'ready' },
        translations: {},
      },
      {
        _id: '507f1f77bcf86cd799439012',
        slug: 'gu-2',
        translationGroupId: 'grp-2',
        category: 'national',
        status: 'published',
        stateTags: ['gujarat'],
        originalLang: 'gu',
        lang: 'gu',
        language: 'gu',
        title: 'અપૂર્ણ',
        description: 'અપૂર્ણ',
        content: 'અપૂર્ણ',
        translationStatus: { en: 'pending' },
        translations: {
          en: {
            title: 'Pending title',
            summary: 'Pending summary',
            content: 'Pending content',
            provider: 'google',
            generatedAt: new Date('2026-03-06T00:00:00.000Z'),
          },
        },
      },
    ];

    function matchesQuery(doc) {
      // Minimal behavior: when lang=en is requested, the endpoint should include
      // either originals authored in en OR docs with translationStatus.en === 'ready'.
      const base = String(doc.originalLang || doc.lang || doc.language || '').toLowerCase();
      if (base === 'en') return true;
      return String(doc?.translationStatus?.en || '').toLowerCase() === 'ready';
    }

    News.find = (q) => {
      capture.query = q;
      capture.filtered = dataset.filter(matchesQuery);
      return makeChainableQuery(capture.filtered, capture);
    };
    News.countDocuments = async (q) => {
      assert.deepEqual(q, capture.query);
      return (capture.filtered || []).length;
    };

    const res = await request(app)
      .get('/api/articles/national/state/gujarat?lang=en&page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');
    assert.equal(res.body.data.lang, 'en');
    assert.equal(res.body.data.items.length, 1);

    const item = res.body.data.items[0];
    // Dedupe by translationGroupId should prefer the original-in-lang variant.
    assert.equal(item.slug, 'en-1');
    assert.equal(item.lang, 'en');
    assert.equal(item.language, 'en');
    assert.equal(item.title, 'Original English title');
    assert.equal(item.description, 'Original English summary');
    assert.equal(item.content, 'Original English content');

    assert.ok(capture.query);
    assert.equal(capture.query.category, 'national');
    assert.equal(capture.query.stateTags, 'gujarat');
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);

    // Ensure the query requires either originals in en OR a fully-ready cached translation.
    const qJson = JSON.stringify(capture.query).toLowerCase();
    assert.ok(qJson.includes('published'));
    assert.ok(qJson.includes('translationstatus.en'));
    assert.ok(qJson.includes('translations.en.title'));
    assert.ok(qJson.includes('translations.en.summary'));
    assert.ok(qJson.includes('translations.en.content'));
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('GET /api/articles/national/state/:stateSlug rejects invalid slug (400)', async () => {
  const res = await request(app)
    .get('/api/articles/national/state/not-a-real-state');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});
