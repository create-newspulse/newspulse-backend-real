const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const Article = require('../models/Article');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) Article[k] = v;
}

function makeChainableQuery(result) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => result,
  };
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

    Article.findOne = () => ({ lean: async () => story });

    const res = await request(app).get('/api/public/stories/test-story-2');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.imageUrl, 'https://example.com/legacy-cover.jpg');
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories resolves imageUrl per story and ignores stale derived imageUrl fields', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = Article.find;
  const prevCount = Article.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      {
        _id: '507f1f77bcf86cd799439031',
        slug: 'story-one',
        title: 'Story one',
        excerpt: 'Excerpt 1',
        status: 'published',
        imageUrl: 'https://img.example/stale-story-1.jpg',
        coverImageUrl: null,
        imageURL: null,
        coverImage: { url: 'https://img.example/story-cover-1.jpg', alt: 'Story one' },
      },
      {
        _id: '507f1f77bcf86cd799439032',
        slug: 'story-two',
        title: 'Story two',
        excerpt: 'Excerpt 2',
        status: 'published',
        imageUrl: 'https://img.example/stale-story-2.jpg',
        coverImageUrl: 'https://img.example/story-cover-2.jpg',
        imageURL: 'https://img.example/story-cover-2.jpg',
        coverImage: null,
      },
    ];

    Article.find = () => makeChainableQuery(dataset);
    Article.countDocuments = async () => dataset.length;

    const res = await request(app)
      .get('/api/public/stories?limit=2')
      .expect(200);

    assert.equal(Array.isArray(res.body.data), true);
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.data[0].imageUrl, 'https://img.example/story-cover-1.jpg');
    assert.equal(res.body.data[1].imageUrl, 'https://img.example/story-cover-2.jpg');
    assert.notEqual(res.body.data[0].imageUrl, res.body.data[1].imageUrl);
  } finally {
    Article.find = prevFind;
    Article.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});
