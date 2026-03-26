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
    sort() { return this; },
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
      slugs: { en: 's1', hi: 's1-hi' },
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

    const res = await request(app).get('/api/public/news/s1-hi?lang=hi');
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

test('GET /api/public/news/:slugOrId?lang=hi falls back to base content when translation is missing (no on-demand translate)', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439012',
      slug: 's2',
      slugs: { en: 's2', hi: 's2-hi' },
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

    const res = await request(app).get('/api/public/news/s2-hi?lang=hi');
    assert.equal(res.statusCode, 404);
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=hi falls back to base content when translation is failed/cooldown', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };

  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439013',
      slug: 's3',
      slugs: { en: 's3', hi: 's3-hi' },
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

    const res = await request(app).get('/api/public/news/s3-hi?lang=hi');
    assert.equal(res.statusCode, 404);
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});
