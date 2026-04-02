const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function makeChainableQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
  };
}

test('GET /api/public/news includes normalized imageUrl (+ alt) when coverImage exists', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      {
        _id: '507f1f77bcf86cd799439011',
        title: 't',
        description: 'd',
        content: '<p>Body</p>',
        status: 'published',
        lang: 'gu',
        language: 'gu',
        coverImageUrl: null,
        imageURL: null,
        coverImage: { url: 'https://img.example/cover.jpg', alt: 'Featured', publicId: null },
      },
    ];

    News.find = () => makeChainableQuery(dataset);
    News.countDocuments = async () => dataset.length;

    const res = await request(app)
      .get('/api/public/news?limit=1')
      .expect(200);

    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);

    const item = res.body.items[0];
    assert.equal(item.imageUrl, 'https://img.example/cover.jpg');
    // Backward compat field remains populated
    assert.equal(item.coverImageUrl, 'https://img.example/cover.jpg');
    assert.equal(item.imageAlt, 'Featured');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news resolves imageUrl per article and ignores stale derived imageUrl fields', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      {
        _id: '507f1f77bcf86cd799439021',
        title: 'Story one',
        description: 'd1',
        content: '<p>Body</p>',
        status: 'published',
        lang: 'gu',
        language: 'gu',
        imageUrl: 'https://img.example/stale-derived.jpg',
        coverImageUrl: null,
        imageURL: null,
        coverImage: { url: 'https://img.example/cover-1.jpg', alt: 'One', publicId: null },
      },
      {
        _id: '507f1f77bcf86cd799439022',
        title: 'Story two',
        description: 'd2',
        content: '<p>Body</p>',
        status: 'published',
        lang: 'gu',
        language: 'gu',
        imageUrl: 'https://img.example/another-stale-derived.jpg',
        coverImageUrl: 'https://img.example/cover-2.jpg',
        imageURL: 'https://img.example/cover-2.jpg',
        coverImage: null,
      },
    ];

    News.find = () => makeChainableQuery(dataset);
    News.countDocuments = async () => dataset.length;

    const res = await request(app)
      .get('/api/public/news?limit=2')
      .expect(200);

    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.items[0].imageUrl, 'https://img.example/cover-1.jpg');
    assert.equal(res.body.items[1].imageUrl, 'https://img.example/cover-2.jpg');
    assert.notEqual(res.body.items[0].imageUrl, res.body.items[1].imageUrl);
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId extracts first <img src> into imageUrl when explicit image is missing', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439012',
      slug: 's-img',
      slugs: { en: 's-img' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      description: 'Summary',
      content: '<p>Intro</p><img src="https://img.example/inline.jpg" alt="x" /><p>More</p>',
      coverImageUrl: null,
      imageURL: null,
      coverImage: null,
      translations: {},
      translationStatus: {},
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app)
      .get('/api/public/news/s-img')
      .expect(200);

    assert.equal(res.body.slug, 's-img');
    assert.equal(res.body.imageUrl, 'https://img.example/inline.jpg');
    assert.equal(res.body.coverImageUrl, 'https://img.example/inline.jpg');
  } finally {
    News.findOne = prevFindOne;
    mongoose.connection.readyState = prevReadyState;
  }
});
