const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const Article = require('../models/Article');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) Article[k] = v;
}

test('GET /api/public/stories includes normalized imageUrl', async () => {
  const originals = { find: Article.find };
  try {
    const story = {
      _id: '507f1f77bcf86cd799439011',
      slug: 'test-story',
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      coverImage: { url: 'https://example.com/cover.jpg', alt: 'Alt' },
    };

    Article.find = () => ({
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => [story],
    });

    const res = await request(app).get('/api/public/stories?lang=en&limit=1&page=1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(Array.isArray(res.body.data), true);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].imageUrl, 'https://example.com/cover.jpg');
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories/:slug includes normalized imageUrl', async () => {
  const originals = { findOne: Article.findOne };
  try {
    const story = {
      _id: '507f1f77bcf86cd799439012',
      slug: 'test-story-2',
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      coverImage: 'https://example.com/legacy-cover.jpg',
    };

    // Endpoint now calls .sort(...).lean() on the query.
    Article.findOne = () => ({
      sort() { return this; },
      lean: async () => story,
    });

    const res = await request(app).get('/api/public/stories/test-story-2');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.imageUrl, 'https://example.com/legacy-cover.jpg');
  } finally {
    restore(originals);
  }
});
