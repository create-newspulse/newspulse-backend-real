const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

function makeFindOneResult(doc, capture) {
  return {
    select() { return this; },
    lean: async () => {
      if (typeof capture === 'function') capture();
      return doc;
    },
  };
}

test('GET /api/public/news/:slugOrId?lang=hi returns cached translations when present (no update)', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    let updateCalls = 0;
    News.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const doc = {
      _id: '507f1f77bcf86cd799439011',
      slug: 's1',
      slugs: { en: 's1' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      description: 'Summary',
      content: 'Body',
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: 'शरीर', generatedAt: new Date().toISOString() },
      },
      translationStatus: { hi: 'ready' },
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/s1?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'नमस्ते');
    assert.equal(res.body.description, 'सारांश');
    assert.equal(res.body.content, 'शरीर');
    assert.equal(res.body.requestedLang, 'hi');
    assert.equal(res.body.resolvedLang, 'hi');
    assert.equal(res.body.isTranslated, true);
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=gu resolves localized slug and returns Gujarati fields when present', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    let updateCalls = 0;
    News.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const doc = {
      _id: '507f1f77bcf86cd799439014',
      slug: 'base-slug',
      slugs: { en: 'base-slug', gu: 'gu-localized-slug' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      description: 'Summary',
      content: 'Body',
      translations: {
        gu: { title: 'હેલો', summary: 'સારાંશ', content: 'મુખ્ય લેખ', generatedAt: new Date().toISOString() },
      },
      translationStatus: { gu: 'ready' },
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/gu-localized-slug?lang=gu');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'હેલો');
    assert.equal(res.body.description, 'સારાંશ');
    assert.equal(res.body.content, 'મુખ્ય લેખ');
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'gu');
    assert.equal(res.body.isTranslated, true);
    assert.equal(res.body.canonicalSlug, 'gu-localized-slug');
    assert.equal(res.body.localizedSlug, 'gu-localized-slug');
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId infers Gujarati locale from localized slug when lang is omitted', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });

    const doc = {
      _id: '507f1f77bcf86cd799439016',
      slug: 'base-slug-implicit',
      slugs: { en: 'base-slug-implicit', gu: 'gu-localized-implicit' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Hello implicit',
      description: 'Summary implicit',
      content: 'Body implicit',
      translations: {
        gu: { title: 'અનુવાદિત', summary: 'ગુજરાતી સાર', content: 'ગુજરાતી બોડી', generatedAt: new Date().toISOString() },
      },
      translationStatus: { gu: 'ready' },
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/gu-localized-implicit');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'gu');
    assert.equal(res.body.title, 'અનુવાદિત');
    assert.equal(res.body.canonicalSlug, 'gu-localized-implicit');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=gu returns 404 when Gujarati is not published and fallback is disabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    let updateCalls = 0;
    News.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const doc = {
      _id: '507f1f77bcf86cd799439015',
      slug: 'base-fallback-slug',
      slugs: { en: 'base-fallback-slug', gu: 'gu-fallback-slug' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Fallback title',
      description: 'Fallback summary',
      content: 'Fallback body',
      translations: {},
      translationStatus: {},
      translationNextRetryAt: {},
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/base-fallback-slug?lang=gu');
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.requestedLang, 'gu');
    assert.deepEqual(res.body.publishedLocales, ['en']);
    assert.equal(res.body.translationAvailability.requestedLocalePublished, false);
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId infers Gujarati locale from slug and falls back only when explicitly enabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });

    const doc = {
      _id: '507f1f77bcf86cd799439017',
      slug: 'base-fallback-implicit',
      slugs: { en: 'base-fallback-implicit', gu: 'gu-fallback-implicit' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Fallback implicit',
      description: 'Fallback implicit summary',
      content: 'Fallback implicit body',
      translations: {},
      translationStatus: {},
      translationNextRetryAt: {},
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/gu-fallback-implicit?fallback=true');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.title, 'Fallback implicit');
    assert.equal(res.body.canonicalSlug, 'base-fallback-implicit');
    assert.equal(res.body.canonicalDetailUrl, '/news/base-fallback-implicit');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=hi returns 404 when Hindi is not published and fallback is disabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439012',
      slug: 's2',
      slugs: { en: 's2' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: null,
      title: 'Hello',
      description: 'Summary',
      content: '<p>Body</p>',
      translations: {},
      translationStatus: {},
      translationNextRetryAt: {},
    };

    let updateCalls = 0;
    News.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/s2?lang=hi');
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.requestedLang, 'hi');
    assert.deepEqual(res.body.publishedLocales, ['en']);
    assert.equal(res.body.translationAvailability.requestedLocalePublished, false);
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=hi falls back to base content only when explicitly enabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439013',
      slug: 's3',
      slugs: { en: 's3' },
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      description: 'Summary',
      content: 'Body',
      translations: {},
      translationStatus: { hi: 'failed' },
      translationNextRetryAt: { hi: new Date(Date.now() + 30 * 60 * 1000) },
    };

    let updateCalls = 0;
    News.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/s3?lang=hi&fallback=true');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requestedLang, 'hi');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.isTranslated, false);
    assert.equal(res.body.title, 'Hello');
    assert.equal(res.body.description, 'Summary');
    assert.equal(res.body.content, 'Body');
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});
