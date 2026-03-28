const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const Article = require('../models/Article');
const { PUBLIC_CATEGORY_DEFINITIONS } = require('../lib/categories');

function matchesCategoryFilter(filterValue, category) {
  if (!filterValue) return true;
  const value = String(category || '');

  if (filterValue instanceof RegExp) return filterValue.test(value);

  if (filterValue && typeof filterValue === 'object' && Array.isArray(filterValue.$in)) {
    return filterValue.$in.some((item) => item instanceof RegExp ? item.test(value) : item === value);
  }

  return filterValue === value;
}

function makeNewsQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function makeArticleQuery(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

test('Science & Technology canonical mapping stays tech with public slug science-technology', () => {
  assert.deepEqual(PUBLIC_CATEGORY_DEFINITIONS.tech, {
    key: 'tech',
    label: 'Science & Technology',
    publicSlug: 'science-technology',
    matchValues: [
      'tech',
      'science-technology',
      'science-and-technology',
      'sci-tech',
      'science_and_technology',
    ],
  });
});

test('GET /api/public/news?category=science-technology&lang=en returns published tech stories across legacy aliases', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { find: News.find, countDocuments: News.countDocuments };

  try {
    mongoose.connection.readyState = 1;

    const docs = [
      { _id: '1', title: 'Canonical tech', description: 'd', content: 'c', slug: 'canonical-tech', category: 'tech', status: 'published', lang: 'en', language: 'en', originalLang: 'en' },
      { _id: '2', title: 'Legacy science technology', description: 'd', content: 'c', slug: 'legacy-science-technology', category: 'science-technology', status: 'published', lang: 'en', language: 'en', originalLang: 'en' },
      { _id: '3', title: 'Legacy sci tech', description: 'd', content: 'c', slug: 'legacy-sci-tech', category: 'sci-tech', status: 'published', lang: 'en', language: 'en', originalLang: 'en' },
      { _id: '4', title: 'Legacy underscore', description: 'd', content: 'c', slug: 'legacy-underscore', category: 'science_and_technology', status: 'published', lang: 'en', language: 'en', originalLang: 'en' },
      { _id: '5', title: 'Sports story', description: 'd', content: 'c', slug: 'sports-story', category: 'sports', status: 'published', lang: 'en', language: 'en', originalLang: 'en' },
    ];

    News.find = (filter) => makeNewsQuery(docs.filter((doc) => matchesCategoryFilter(filter.category, doc.category)));
    News.countDocuments = async (filter) => docs.filter((doc) => matchesCategoryFilter(filter.category, doc.category)).length;

    const res = await request(app).get('/api/public/news?category=science-technology&lang=en&limit=10');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(res.body.items.map((item) => item.category).sort(), ['sci-tech', 'science-technology', 'science_and_technology', 'tech']);
  } finally {
    News.find = originals.find;
    News.countDocuments = originals.countDocuments;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news category listing resolves science-technology by translation group for hi and gu', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { find: News.find, countDocuments: News.countDocuments };

  try {
    mongoose.connection.readyState = 1;

    const docs = [
      {
        _id: '6',
        title: 'English tech news',
        description: 'English tech summary',
        content: 'English tech content',
        slug: 'news-tech-en',
        slugs: { en: 'news-tech-en', hi: 'news-tech-hi', gu: 'news-tech-gu' },
        category: 'tech',
        status: 'published',
        lang: 'en',
        language: 'en',
        originalLang: 'en',
        translationKey: 'grp-news-1',
        translationGroupId: 'grp-news-1',
        translations: {
          gu: {
            title: 'ગુજરાતી ટેક સમાચાર',
            summary: 'ગુજરાતી ટેક સારાંશ',
            content: 'ગુજરાતી ટેક સામગ્રી',
          },
        },
        translationStatus: { gu: 'ready' },
        createdAt: '2026-03-29T09:00:00.000Z',
        publishedAt: '2026-03-29T09:00:00.000Z',
      },
      {
        _id: '7',
        title: 'हिंदी टेक समाचार',
        description: 'हिंदी टेक सारांश',
        content: 'हिंदी टेक सामग्री',
        slug: 'news-tech-hi',
        slugs: { en: 'news-tech-en', hi: 'news-tech-hi', gu: 'news-tech-gu' },
        category: '',
        status: 'published',
        lang: 'hi',
        language: 'hi',
        originalLang: 'hi',
        translationKey: 'grp-news-1',
        translationGroupId: 'grp-news-1',
        translations: {},
        translationStatus: {},
        createdAt: '2026-03-29T09:05:00.000Z',
        publishedAt: '2026-03-29T09:05:00.000Z',
      },
    ];

    News.find = (query) => {
      const queryJson = JSON.stringify(query || {});
      if (queryJson.includes('grp-news-1')) return makeNewsQuery(docs);
      return makeNewsQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));
    };
    News.countDocuments = async () => docs.length;

    const hiRes = await request(app).get('/api/public/news?category=science-technology&lang=hi&limit=10&page=1');
    assert.equal(hiRes.statusCode, 200);
    assert.equal(hiRes.body.items.length, 1);
    assert.equal(hiRes.body.items[0].title, 'हिंदी टेक समाचार');
    assert.equal(hiRes.body.items[0].lang, 'hi');

    const guRes = await request(app).get('/api/public/news?category=science-technology&lang=gu&limit=10&page=1');
    assert.equal(guRes.statusCode, 200);
    assert.equal(guRes.body.items.length, 1);
    assert.equal(guRes.body.items[0].title, 'ગુજરાતી ટેક સમાચાર');
    assert.equal(guRes.body.items[0].lang, 'gu');
  } finally {
    News.find = originals.find;
    News.countDocuments = originals.countDocuments;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/articles?category=science-technology includes canonical tech records', async () => {
  const originals = { find: News.find, countDocuments: News.countDocuments };

  try {
    const docs = [
      { _id: '11', title: 'Canonical tech', description: 'd', content: 'c', slug: 'canonical-tech', category: 'tech', status: 'published', lang: 'en', language: 'en', originalLang: 'en', createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() },
      { _id: '12', title: 'Legacy science technology', description: 'd', content: 'c', slug: 'legacy-science-technology', category: 'science-technology', status: 'published', lang: 'en', language: 'en', originalLang: 'en', createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() },
      { _id: '13', title: 'Sports story', description: 'd', content: 'c', slug: 'sports-story', category: 'sports', status: 'published', lang: 'en', language: 'en', originalLang: 'en', createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() },
    ];

    News.find = (query) => makeNewsQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));
    News.countDocuments = async (query) => docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)).length;

    const res = await request(app).get('/api/public/articles?category=science-technology&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.items.length, 2);
    assert.ok(res.body.data.items.some((item) => item.category === 'tech'));
  } finally {
    News.find = originals.find;
    News.countDocuments = originals.countDocuments;
  }
});

test('GET /api/public/stories?category=science-technology maps the public slug to tech-compatible values', async () => {
  const originals = { find: Article.find };

  try {
    const docs = [
      { _id: '21', title: 'Canonical tech', summary: 'd', content: 'c', slug: 'canonical-tech', category: 'tech', status: 'published', language: 'en', originalLang: 'en' },
      { _id: '22', title: 'Legacy sci tech', summary: 'd', content: 'c', slug: 'legacy-sci-tech', category: 'sci-tech', status: 'published', language: 'en', originalLang: 'en' },
      { _id: '23', title: 'Business story', summary: 'd', content: 'c', slug: 'business-story', category: 'business', status: 'published', language: 'en', originalLang: 'en' },
    ];

    Article.find = (query) => makeArticleQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));

    const res = await request(app).get('/api/public/stories?category=science-technology&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 2);
    assert.deepEqual(res.body.data.map((item) => item.category).sort(), ['sci-tech', 'tech']);
  } finally {
    Article.find = originals.find;
  }
});

test('GET /api/public/articles category listing resolves science-technology by translation group for hi and gu', async () => {
  const originals = { find: News.find, countDocuments: News.countDocuments };

  try {
    const docs = [
      {
        _id: '31',
        title: 'English tech title',
        description: 'English tech summary',
        content: 'English tech content',
        slug: 'science-tech-en',
        slugs: { en: 'science-tech-en', hi: 'science-tech-hi', gu: 'science-tech-gu' },
        category: 'tech',
        status: 'published',
        lang: 'en',
        language: 'en',
        originalLang: 'en',
        translationKey: 'grp-tech-1',
        translationGroupId: 'grp-tech-1',
        translations: {
          gu: {
            title: 'ગુજરાતી વિજ્ઞાન શીર્ષક',
            summary: 'ગુજરાતી વિજ્ઞાન સારાંશ',
            content: 'ગુજરાતી વિજ્ઞાન સામગ્રી',
          },
        },
        translationStatus: { gu: 'ready' },
        createdAt: '2026-03-29T10:00:00.000Z',
        publishedAt: '2026-03-29T10:00:00.000Z',
      },
      {
        _id: '32',
        title: 'हिंदी विज्ञान शीर्षक',
        description: 'हिंदी विज्ञान सारांश',
        content: 'हिंदी विज्ञान सामग्री',
        slug: 'science-tech-hi',
        slugs: { en: 'science-tech-en', hi: 'science-tech-hi', gu: 'science-tech-gu' },
        category: '',
        status: 'published',
        lang: 'hi',
        language: 'hi',
        originalLang: 'hi',
        translationKey: 'grp-tech-1',
        translationGroupId: 'grp-tech-1',
        translations: {},
        translationStatus: {},
        createdAt: '2026-03-29T10:05:00.000Z',
        publishedAt: '2026-03-29T10:05:00.000Z',
      },
    ];

    News.find = (query) => {
      const queryJson = JSON.stringify(query || {});
      if (queryJson.includes('grp-tech-1')) return makeNewsQuery(docs);
      return makeNewsQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));
    };
    News.countDocuments = async () => docs.length;

    const hiRes = await request(app).get('/api/public/articles?category=science-technology&lang=hi&limit=10&page=1');
    assert.equal(hiRes.statusCode, 200);
    assert.equal(hiRes.body.ok, true);
    assert.equal(hiRes.body.data.items.length, 1);
    assert.equal(hiRes.body.data.items[0].title, 'हिंदी विज्ञान शीर्षक');
    assert.equal(hiRes.body.data.items[0].language, 'hi');
    assert.equal(hiRes.body.data.items[0].slug, 'science-tech-hi');

    const guRes = await request(app).get('/api/public/articles?category=science-technology&lang=gu&limit=10&page=1');
    assert.equal(guRes.statusCode, 200);
    assert.equal(guRes.body.ok, true);
    assert.equal(guRes.body.data.items.length, 1);
    assert.equal(guRes.body.data.items[0].title, 'ગુજરાતી વિજ્ઞાન શીર્ષક');
    assert.equal(guRes.body.data.items[0].language, 'gu');
    assert.equal(guRes.body.data.items[0].slug, 'science-tech-gu');
  } finally {
    News.find = originals.find;
    News.countDocuments = originals.countDocuments;
  }
});

test('GET /api/public/stories category listing resolves science-technology by translation group for hi and gu', async () => {
  const originals = { find: Article.find };

  try {
    const docs = [
      {
        _id: '41',
        title: 'English tech title',
        summary: 'English tech summary',
        content: 'English tech content',
        slug: 'science-tech-en',
        slugs: { en: 'science-tech-en', hi: 'science-tech-hi', gu: 'science-tech-gu' },
        category: 'tech',
        status: 'published',
        language: 'en',
        originalLang: 'en',
        translationKey: 'grp-tech-2',
        translationGroupId: 'grp-tech-2',
        translations: {
          gu: {
            title: 'ગુજરાતી સ્ટોરી શીર્ષક',
            summary: 'ગુજરાતી સ્ટોરી સારાંશ',
            content: 'ગુજરાતી સ્ટોરી સામગ્રી',
          },
        },
        translationStatus: { gu: 'ready' },
        createdAt: '2026-03-29T11:00:00.000Z',
        publishedAt: '2026-03-29T11:00:00.000Z',
      },
      {
        _id: '42',
        title: 'हिंदी स्टोरी शीर्षक',
        summary: 'हिंदी स्टोरी सारांश',
        content: 'हिंदी स्टोरी सामग्री',
        slug: 'science-tech-hi',
        slugs: { en: 'science-tech-en', hi: 'science-tech-hi', gu: 'science-tech-gu' },
        category: '',
        status: 'published',
        language: 'hi',
        originalLang: 'hi',
        translationKey: 'grp-tech-2',
        translationGroupId: 'grp-tech-2',
        translations: {},
        translationStatus: {},
        createdAt: '2026-03-29T11:05:00.000Z',
        publishedAt: '2026-03-29T11:05:00.000Z',
      },
    ];

    Article.find = (query) => {
      const queryJson = JSON.stringify(query || {});
      if (queryJson.includes('grp-tech-2')) return makeArticleQuery(docs);
      return makeArticleQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));
    };

    const hiRes = await request(app).get('/api/public/stories?category=science-technology&lang=hi&limit=10&page=1');
    assert.equal(hiRes.statusCode, 200);
    assert.equal(hiRes.body.success, true);
    assert.equal(hiRes.body.data.length, 1);
    assert.equal(hiRes.body.data[0].title, 'हिंदी स्टोरी शीर्षक');
    assert.equal(hiRes.body.data[0].language, 'hi');

    const guRes = await request(app).get('/api/public/stories?category=science-technology&lang=gu&limit=10&page=1');
    assert.equal(guRes.statusCode, 200);
    assert.equal(guRes.body.success, true);
    assert.equal(guRes.body.data.length, 1);
    assert.equal(guRes.body.data[0].title, 'ગુજરાતી સ્ટોરી શીર્ષક');
    assert.equal(guRes.body.data[0].language, 'gu');
  } finally {
    Article.find = originals.find;
  }
});