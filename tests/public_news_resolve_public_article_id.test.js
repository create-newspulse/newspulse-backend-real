const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');

function restore(model, originals) {
  for (const [k, v] of Object.entries(originals)) model[k] = v;
}

function makeFindOneResult(doc) {
  return {
    select() {
      return this;
    },
    lean: async () => doc,
  };
}

test('GET /api/public/news/:slugOrId resolves PublicArticle _id when News is missing', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const newsOriginals = { findOne: News.findOne };
  const paOriginals = { findOne: PublicArticle.findOne };

  try {
    mongoose.connection.readyState = 1;

    // Simulate News miss.
    News.findOne = () => makeFindOneResult(null);

    const articleDoc = {
      _id: '507f1f77bcf86cd799439099',
      status: 'published',
      publishedAt: new Date().toISOString(),
      slug: 'pa1',
      slugs: { en: 'pa1', gu: 'pa1-gu' },
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'SummaryA',
      content: 'BodyA',
      translations: {
        gu: { title: 'હેલ્લો', summary: 'સાર', content: 'દેહ', generatedAt: new Date().toISOString(), provider: 'google' },
      },
      translationStatus: { gu: 'ready' },
      coverImage: { url: null, publicId: null, alt: null },
    };

    PublicArticle.findOne = () => makeFindOneResult(articleDoc);

    const res = await request(app).get('/api/public/news/507f1f77bcf86cd799439099?lang=gu');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'હેલ્લો');
    assert.equal(res.body.description, 'સાર');
    assert.equal(res.body.content, 'દેહ');
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'gu');
    assert.equal(res.body.isTranslated, true);
  } finally {
    restore(News, newsOriginals);
    restore(PublicArticle, paOriginals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId returns 404 for PublicArticle when requested locale is not published and fallback is disabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const newsOriginals = { findOne: News.findOne };
  const paOriginals = { findOne: PublicArticle.findOne };

  try {
    mongoose.connection.readyState = 1;

    News.findOne = () => makeFindOneResult(null);

    const articleDoc = {
      _id: '507f1f77bcf86cd799439098',
      status: 'published',
      publishedAt: new Date().toISOString(),
      slug: 'pa2',
      slugs: { en: 'pa2' },
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'SummaryB',
      content: '<p>BodyB</p>',
      translations: {},
      translationStatus: {},
      coverImage: { url: null, publicId: null, alt: null },
    };

    PublicArticle.findOne = () => makeFindOneResult(articleDoc);

    const res = await request(app).get('/api/public/news/507f1f77bcf86cd799439098?lang=hi');
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.requestedLang, 'hi');
    assert.deepEqual(res.body.publishedLocales, ['en']);
    assert.equal(res.body.translationAvailability.requestedLocalePublished, false);
  } finally {
    restore(News, newsOriginals);
    restore(PublicArticle, paOriginals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId allows PublicArticle base fallback when explicitly enabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const newsOriginals = { findOne: News.findOne };
  const paOriginals = { findOne: PublicArticle.findOne };

  try {
    mongoose.connection.readyState = 1;

    News.findOne = () => makeFindOneResult(null);

    const articleDoc = {
      _id: '507f1f77bcf86cd799439097',
      status: 'published',
      publishedAt: new Date().toISOString(),
      slug: 'pa3',
      slugs: { en: 'pa3', hi: 'pa3-hi' },
      language: 'en',
      originalLang: 'en',
      title: 'Hello C',
      summary: 'SummaryC',
      content: '<p>BodyC</p>',
      translations: {},
      translationStatus: {},
      coverImage: { url: null, publicId: null, alt: null },
    };

    PublicArticle.findOne = () => makeFindOneResult(articleDoc);

    const res = await request(app).get('/api/public/news/507f1f77bcf86cd799439097?lang=hi&fallback=true');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'Hello C');
    assert.equal(res.body.description, 'SummaryC');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.translationAvailability.requestedLocalePublished, false);
    assert.equal(res.body.canonicalDetailUrl, '/news/pa3');
  } finally {
    restore(News, newsOriginals);
    restore(PublicArticle, paOriginals);
    mongoose.connection.readyState = prevReadyState;
  }
});
