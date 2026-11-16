require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const Article = require('../models/Article');
const News = require('../models/News');
const { publicListingCursor } = require('./helpers/publicListingCursor');
const { runPipeline } = require('./helpers/pulseDialogueAggregate');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');

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
    cursor(options) {
      capture.cursor = { options };
      return publicListingCursor(() => this.lean(), capture.cursor);
    },
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
        status: 'published',
        publishedAt: new Date('2026-01-02T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-05T00:00:00.000Z'),
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
    assert.equal(item._id, dataset[0]._id);
    assert.equal(item.slug, 'gu-1');
    assert.equal(item.canonicalSlug, 'en-1');
    assert.equal(item.imageUrl, 'https://img.example/1.jpg');
    assert.equal(item.title, 'Translated title');
    assert.equal(item.summary, 'Translated summary');
    assert.equal(item.content, 'Translated content');
    assert.equal(item.provider, 'google');
    assert.equal(new Date(item.generatedAt).toISOString(), '2026-03-06T00:00:00.000Z');
    assert.equal(item.status, 'published');
    assert.equal(item.language, 'en');
    assert.equal(item.lang, 'en');
    assert.equal(item.originalLang, 'gu');
    assert.equal(item.requestedLang, 'en');
    assert.equal(item.resolvedLang, 'en');
    assert.equal(item.isTranslated, true);
    assert.equal(item.isFallback, false);
    for (const field of ['publishedAt', 'createdAt', 'updatedAt']) {
      assert.equal(item[field], dataset[0][field].toISOString(), field);
    }
    assert.notEqual(item.publishedAt, item.generatedAt);

    // Query should include ready-only translation match for the requested lang.
    assert.ok(capture.query);
    assert.equal(capture.query.category, 'regional');
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, null, 'Pagination must not skip candidates before parent validation');
    assert.equal(capture.cursor.closed, true);
    assert.equal(capture.limit, 20);

    // Shared visibility filter is expressed via $and clauses.
    const qJson = JSON.stringify(capture.query).toLowerCase();
    assert.ok(qJson.includes('published'));

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

test('Regional metadata retains legacy lang through the database projection', async t => {
  const text = {
    en: 'Regional English news',
    hi: '\u0915\u094d\u0937\u0947\u0924\u094d\u0930\u0940\u092f \u0938\u092e\u093e\u091a\u093e\u0930',
    gu: '\u0aaa\u0acd\u0ab0\u0abe\u0aa6\u0ac7\u0ab6\u0abf\u0a95 \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0',
  };
  for (const [original, requested] of [['en', 'en'], ['hi', 'hi'], ['gu', 'gu'], ['en', 'gu']]) {
    await t.test(`${original} original requested in ${requested}`, async context => {
      const doc = {
        _id: '507f1f77bcf86cd799439041',
        slug: `legacy-regional-${original}`,
        slugs: { [original]: `legacy-regional-${original}` },
        category: 'regional', status: 'published', lang: original.toUpperCase(),
        title: text[original], summary: text[original], content: `<p>${text[original]}</p>`,
        geo: { state: 'gujarat' }, translations: {}, translationStatus: {},
        publishedAt: new Date('2026-01-02T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      };
      context.mock.method(Article, 'find', () => {
        const capture = {};
        const query = makeChainableQuery([doc], capture);
        query.lean = async () => runPipeline([doc], [{
          $project: Object.fromEntries(capture.selectArg.split(/\s+/).map(field => [field, 1])),
        }]);
        return query;
      });
      context.mock.method(Article, 'countDocuments', async () => 1);

      for (const path of [
        `/api/public/regional?state=gujarat&lang=${requested}`,
        `/api/public/regional/gujarat?lang=${requested}`,
      ]) {
        const response = await request(app).get(path);
        assert.equal(response.status, 200, path);
        assert.equal(response.body.data.lang, requested);
        assert.equal(response.body.data.total, 1);
        assert.equal(response.body.data.items.length, 1);
        const [item] = response.body.data.items;
        assert.equal(item._id, doc._id);
        assert.equal(item.slug, doc.slug);
        assert.equal(item.title, doc.title);
        assert.equal(item.summary, doc.summary);
        assert.equal(item.content, doc.content);
        assert.equal(item.status, doc.status);
        assert.equal(item.language, original);
        assert.equal(item.lang, original);
        assert.equal(item.originalLang, original);
        assert.equal(item.resolvedLang, original);
        assert.equal(item.requestedLang, requested);
        assert.equal(item.isTranslated, false);
        assert.equal(item.isFallback, original !== requested);
        for (const field of ['publishedAt', 'createdAt', 'updatedAt']) {
          assert.equal(item[field], doc[field].toISOString(), field);
        }
      }
    });
  }
});

test('Regional metadata preserves null and absent dates without using translation generation dates', async t => {
  for (const absent of [null, undefined]) {
    await t.test(`stored dates are ${String(absent)}`, async context => {
      const doc = {
        _id: '507f1f77bcf86cd799439042',
        slug: 'legacy-regional-dates', category: 'regional', status: 'published',
        originalLang: 'gu', language: 'gu', geo: { state: 'gujarat' },
        publishedAt: absent, createdAt: absent, updatedAt: absent,
        translationStatus: { en: 'ready' },
        translations: {
          en: {
            title: 'Translated regional title', summary: 'Translated regional summary',
            content: '<p>Translated regional content</p>',
            generatedAt: new Date('2026-03-06T00:00:00.000Z'),
          },
        },
      };
      context.mock.method(Article, 'find', () => makeChainableQuery([doc], {}));
      context.mock.method(Article, 'countDocuments', async () => 1);

      for (const path of ['/api/public/regional?state=gujarat&lang=en', '/api/public/regional/gujarat?lang=en']) {
        const response = await request(app).get(path);
        assert.equal(response.status, 200, path);
        assert.equal(response.body.data.total, 1);
        assert.equal(response.body.data.items.length, 1);
        const [item] = response.body.data.items;
        assert.equal(item.status, 'published');
        assert.equal(item.generatedAt, '2026-03-06T00:00:00.000Z');
        for (const field of ['publishedAt', 'createdAt', 'updatedAt']) {
          assert.equal(item[field], absent, field);
          assert.equal(Object.hasOwn(item, field), absent === null, field);
        }
      }
    });
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

test('GET /api/public/regional ignores district/city "all" sentinel values (state-only query still works)', async () => {
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

    const res = await request(app).get('/api/public/regional?state=gujarat&district=all&city=all&lang=gu&page=1&limit=20');

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
    assert.ok(!asJson.includes('district:all'));
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
        status: 'published',
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
        status: 'published',
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
        status: 'published',
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
        status: 'published',
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

test('canonical Regional sync satisfies the unchanged Gujarat state predicate', async (t) => {
  const sources = [[], ['district:ahmedabad'], ['city:vadodara']].map((tags, index) => ({
    _id: `507f1f77bcf86cd79943940${index}`,
    slug: `regional-metadata-${index}`,
    title: `Local transport update ${index}`,
    description: 'Local summary',
    content: '<p>Local details</p>',
    category: 'regional',
    status: 'published',
    language: 'en',
    originalLang: 'en',
    publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    geo: { state: null, district: null, city: null },
    location: null,
    tags,
  }));
  t.mock.method(Article, 'findOneAndUpdate', (_filter, update) => ({
    lean: async () => ({ _id: update.$set.sourceNewsId, ...update.$set }),
  }));
  t.mock.method(Article, 'find', () => makeChainableQuery([], {}));
  t.mock.method(News, 'find', filter => makeChainableQuery(sources.filter(source => (
    filter._id.$in.some(value => String(value) === source._id)
  )), {}));
  const synced = await Promise.all(sources.map((source) => syncPublicArticleFromNews(source, { throwOnError: true })));
  assert.ok(synced.every(Boolean));
  const capture = {};
  const matchingState = (doc, stateClause) => stateClause.$or.some((clause) =>
    Object.entries(clause).every(([field, condition]) => {
      const value = field.split('.').reduce((item, key) => item?.[key], doc);
      if (condition instanceof RegExp) {
        return (Array.isArray(value) ? value : [value]).some((item) =>
          typeof item === 'string' && condition.test(item)
        );
      }
      assert.ok(Array.isArray(condition.$in), 'Use the actual endpoint state alternatives');
      return condition.$in.includes(value);
    })
  );
  const filterItems = (filter) => {
    assert.equal(filter.category, 'regional');
    const stateClause = filter.$and.find((clause) =>
      clause.$or?.some((alternative) => Object.hasOwn(alternative, 'geo.state'))
    );
    assert.ok(stateClause, 'The existing feed must still require state metadata');
    for (const [index, doc] of synced.entries()) {
      assert.ok(doc);
      assert.equal(matchingState(sources[index], stateClause), false);
      assert.equal(matchingState(doc, stateClause), true);
      assert.equal(matchingState({ geo: doc.geo }, stateClause), true);
      assert.equal(matchingState({ tags: ['state:gujarat'] }, stateClause), true);
      assert.equal(matchingState({ state: doc.state }, stateClause), true);
      assert.equal(matchingState({ tags: sources[index].tags }, stateClause), false);
    }
    return synced.filter((doc) => matchingState(doc, stateClause));
  };
  t.mock.method(Article, 'find', (filter) => makeChainableQuery(filterItems(filter), capture));
  t.mock.method(Article, 'countDocuments', async (filter) => filterItems(filter).length);

  const res = await request(app).get('/api/public/regional?state=gujarat&lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 3);
  assert.deepEqual(res.body.data.items.map((item) => item.slug), sources.map((source) => source.slug));
  assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
});
