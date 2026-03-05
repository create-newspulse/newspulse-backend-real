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
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/s1?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'नमस्ते');
    assert.equal(res.body.description, 'सारांश');
    assert.equal(res.body.content, 'शरीर');
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=hi generates missing translation, caches atomically, and returns translated fields', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };
  const prevFetch = global.fetch;

  const fetchBodies = [];
  let fetchCalls = 0;
  global.fetch = async (_url, opts) => {
    fetchCalls++;
    const body = JSON.parse(String(opts && opts.body ? opts.body : '{}'));
    fetchBodies.push(body);
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((txt) => ({ translatedText: `T:${txt}` })) } }),
    };
  };

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

    const updateCalls = [];
    News.updateOne = async (filter, update) => {
      updateCalls.push({ filter, update });

      const set = update && update.$set ? update.$set : {};
      if (set['translationStatus.hi'] === 'pending') {
        return { acknowledged: true, modifiedCount: 1 };
      }

      return { acknowledged: true, modifiedCount: 1 };
    };

    News.findOne = () => makeFindOneResult(doc);

    const res = await request(app).get('/api/public/news/s2?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.body.title).startsWith('T:'), 'title should be translated');
    assert.ok(String(res.body.description).startsWith('T:'), 'summary should be translated');
    assert.ok(String(res.body.content).startsWith('T:'), 'content should be translated');

    // Should have lock + persist calls.
    assert.ok(updateCalls.length >= 2, 'should lock + persist');
    const persist = updateCalls[updateCalls.length - 1];
    assert.deepEqual(persist.filter, { _id: '507f1f77bcf86cd799439012' });
    assert.ok(persist.update && persist.update.$set);

    const set = persist.update.$set;
    assert.equal(set.originalLang, 'en');
    assert.ok(set['translations.hi.title']);
    assert.ok(set['translations.hi.summary']);
    assert.ok(set['translations.hi.content']);
    assert.ok(set['translations.hi.generatedAt']);

    assert.equal(set['translationStatus.hi'], 'ready');
    assert.equal(set['translationError.hi'], null);
    assert.equal(set['translationNextRetryAt.hi'], null);

    // Ensure HTML translation uses format: 'html' for content.
    assert.ok(fetchBodies.some((b) => b && b.format === 'html'), 'should call Google Translate with format=html');

    // Expect 3 translate calls: title, summary, content.
    assert.equal(fetchCalls, 3);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news/:slugOrId?lang=hi marks failed + cooldown on 429 and returns originals', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne, updateOne: News.updateOne };
  const prevFetch = global.fetch;

  global.fetch = async () => {
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit exceeded' } }),
    };
  };

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
      translationStatus: {},
      translationNextRetryAt: {},
    };

    const updateCalls = [];
    News.updateOne = async (filter, update) => {
      updateCalls.push({ filter, update });
      const set = update && update.$set ? update.$set : {};
      if (set['translationStatus.hi'] === 'pending') {
        return { acknowledged: true, modifiedCount: 1 };
      }
      return { acknowledged: true, modifiedCount: 1 };
    };

    News.findOne = () => makeFindOneResult(doc);

    const before = Date.now();
    const res = await request(app).get('/api/public/news/s3?lang=hi');
    assert.equal(res.statusCode, 200);

    // Strict fallback: originals (no mixing).
    assert.equal(res.body.title, 'Hello');
    assert.equal(res.body.description, 'Summary');
    assert.equal(res.body.content, 'Body');

    const persist = updateCalls[updateCalls.length - 1];
    const set = persist.update.$set;
    assert.equal(set['translationStatus.hi'], 'failed');
    assert.ok(set['translationNextRetryAt.hi'] instanceof Date, 'nextRetryAt should be a Date');
    const after = Date.now();

    const dt = set['translationNextRetryAt.hi'].getTime();
    assert.ok(dt >= before + (25 * 60 * 1000) && dt <= after + (35 * 60 * 1000), 'cooldown should be ~30 minutes');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
    mongoose.connection.readyState = prevReadyState;
  }
});
