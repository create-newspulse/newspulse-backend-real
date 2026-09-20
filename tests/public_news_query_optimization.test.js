const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function makeCapturingQuery(items, capture) {
  return {
    select(arg) {
      capture.select = arg;
      return this;
    },
    sort(arg) {
      capture.sort = arg;
      return this;
    },
    collation(arg) {
      capture.collation = arg;
      return this;
    },
    lean: async () => items,
  };
}

function findIndexByName(name) {
  return News.schema.indexes().find(([, options]) => options && options.name === name);
}

function assertIndex(name, fields, expectedOptions = {}) {
  const index = findIndexByName(name);
  assert.ok(index, `expected index ${name}`);
  assert.deepEqual(index[0], fields);
  for (const [key, value] of Object.entries({ name, ...expectedOptions })) {
    assert.deepEqual(index[1][key], value);
  }
}

test('public news category query uses indexed exact values with case-insensitive collation', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originalFind = News.find;
  const captures = [];

  try {
    mongoose.connection.readyState = 1;
    News.find = (filter) => {
      const capture = { filter };
      captures.push(capture);
      return makeCapturingQuery([], capture);
    };

    const res = await request(app).get('/api/public/news?category=science-technology&lang=en&page=1&limit=10');

    assert.equal(res.statusCode, 200);
    assert.ok(captures.length >= 1);
    assert.deepEqual(captures[0].filter.category, {
      $in: ['tech', 'science-technology', 'science-and-technology', 'sci-tech', 'science_and_technology'],
    });
    assert.deepEqual(captures[0].sort, { publishedAt: -1, createdAt: -1 });
    assert.deepEqual(captures[0].collation, { locale: 'en', strength: 2 });
  } finally {
    News.find = originalFind;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('News schema includes direct public-news feed and sibling lookup indexes', () => {
  assertIndex('public_news_latest_status_published_created', { status: 1, publishedAt: -1, createdAt: -1 });
  assertIndex(
    'public_news_category_status_published_created_ci',
    { category: 1, status: 1, publishedAt: -1, createdAt: -1 },
    { collation: { locale: 'en', strength: 2 } }
  );
  assertIndex('public_news_sibling_translation_key_status_published_created', { translationKey: 1, status: 1, publishedAt: -1, createdAt: -1 });
  assertIndex('public_news_sibling_translation_group_status_published_created', { translationGroupId: 1, status: 1, publishedAt: -1, createdAt: -1 });
  assertIndex('public_news_sibling_slug_status_published_created', { slug: 1, status: 1, publishedAt: -1, createdAt: -1 });
  assertIndex('public_news_sibling_slugs_en_status_published_created', { 'slugs.en': 1, status: 1, publishedAt: -1, createdAt: -1 });
});