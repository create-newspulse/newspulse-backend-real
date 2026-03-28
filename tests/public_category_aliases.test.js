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

test('GET /api/public/news?category=science-technology returns published tech stories across legacy aliases', async () => {
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

    const res = await request(app).get('/api/public/news?category=science-technology&limit=10');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(res.body.items.map((item) => item.category).sort(), ['sci-tech', 'science-technology', 'science_and_technology', 'tech']);
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