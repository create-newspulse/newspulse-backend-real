const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function makeChainableOne(item) {
  return {
    select() { return this; },
    lean: async () => item,
  };
}

test('GET /api/public/news/translation returns 400 when missing translationKey', async () => {
  const res = await request(app).get('/api/public/news/translation');
  assert.equal(res.statusCode, 400);
});

test('GET /api/public/news/translation returns a published doc by translationKey + lang', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '64b7f2f2f2f2f2f2f2f2f2f2',
      title: 'Hello',
      description: 'Desc',
      slug: 'hello',
      status: 'published',
      lang: 'en',
      language: 'en',
      translationKey: 'tk-1',
      translationGroupId: 'tg-1',
      coverImageUrl: null,
      imageURL: '/uploads/a.png',
    };

    let lastFilter = null;
    News.findOne = (filter) => {
      lastFilter = filter;
      return makeChainableOne(doc);
    };

    const res = await request(app).get('/api/public/news/translation?translationKey=tk-1&lang=en');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.translationKey, 'tk-1');
    assert.equal(res.body.lang, 'en');
    // coverImageUrl should be normalized (fallback to imageURL)
    assert.equal(res.body.coverImageUrl, '/uploads/a.png');

    // Ensure query was built using translationKey OR translationGroupId.
    const ands = Array.isArray(lastFilter && lastFilter.$and) ? lastFilter.$and : [];
    assert.ok(ands.some((c) => c && c.$or && Array.isArray(c.$or) && c.$or.some((x) => x.translationKey === 'tk-1' || x.translationGroupId === 'tk-1')));
  } finally {
    News.findOne = prevFindOne;
    mongoose.connection.readyState = prevReadyState;
  }
});
