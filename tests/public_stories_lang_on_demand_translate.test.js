const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const Article = require('../models/Article');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) Article[k] = v;
}

test('GET /api/public/stories/:slug?lang=hi returns cached translations when present', async () => {
  const originals = { findOne: Article.findOne, updateOne: Article.updateOne };
  try {
    let updateCalls = 0;
    Article.updateOne = async () => {
      updateCalls++;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const story = {
      _id: '507f1f77bcf86cd799439011',
      slug: 'test-story',
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>', provider: 'google', generatedAt: new Date().toISOString() },
      },
    };

    Article.findOne = () => ({ lean: async () => story });

    const res = await request(app).get('/api/public/stories/test-story?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.title, 'नमस्ते');
    assert.equal(res.body.data.summary, 'सारांश');
    assert.equal(res.body.data.content, '<p>शरीर</p>');
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories/:slug?lang=hi auto-generates missing fields, saves, and returns translated body', async () => {
  const originals = { findOne: Article.findOne, updateOne: Article.updateOne };
  const prevFetch = global.fetch;

  const fetchBodies = [];
  global.fetch = async (_url, opts) => {
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
    const story = {
      _id: '507f1f77bcf86cd799439011',
      slug: 'test-story',
      status: 'published',
      language: 'en',
      originalLang: null,
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p><p>More</p>',
      translations: {},
    };

    const updateCalls = [];
    Article.updateOne = async (filter, update) => {
      updateCalls.push({ filter, update });

      // First call is the atomic lock (sets translationStatus.<lang>=pending)
      const set = update && update.$set ? update.$set : {};
      if (set['translationStatus.hi'] === 'pending') {
        return { acknowledged: true, modifiedCount: 1 };
      }

      // Second call persists translated fields/status.
      return { acknowledged: true, modifiedCount: 1 };
    };
    Article.findOne = () => ({ lean: async () => story });

    const res = await request(app).get('/api/public/stories/test-story?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(String(res.body.data.title).startsWith('T:'), 'title should be translated');
    assert.ok(String(res.body.data.summary).startsWith('T:'), 'summary should be translated');
    assert.ok(String(res.body.data.content).startsWith('T:'), 'content should be translated');

    // Should have lock + persist calls.
    assert.ok(updateCalls.length >= 2, 'should call updateOne to lock + persist');
    const persist = updateCalls[updateCalls.length - 1];
    assert.deepEqual(persist.filter, { _id: '507f1f77bcf86cd799439011' });
    assert.ok(persist.update && persist.update.$set, 'should use $set update');

    const set = persist.update.$set;
    assert.equal(set.originalLang, 'en');
    assert.ok(set['translations.hi.title']);
    assert.ok(set['translations.hi.summary']);
    assert.ok(set['translations.hi.content']);
    assert.equal(set['translations.hi.provider'], 'google');
    assert.ok(set['translations.hi.generatedAt']);

    // Status should become ready (and cooldown cleared) on success.
    assert.equal(set['translationStatus.hi'], 'ready');
    assert.equal(set['translationError.hi'], null);
    assert.equal(set['translationNextRetryAt.hi'], null);

    // Ensure HTML translation uses format: 'html'
    assert.ok(fetchBodies.some((b) => b && b.format === 'html'), 'should call Google Translate with format=html for content');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('GET /api/public/stories/:slug detects source language from content when originalLang+language missing', async () => {
  const originals = { findOne: Article.findOne, updateOne: Article.updateOne };
  const prevFetch = global.fetch;

  const fetchBodies = [];
  global.fetch = async (_url, opts) => {
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
    const story = {
      _id: '507f1f77bcf86cd799439012',
      slug: 'test-story-2',
      status: 'published',
      language: null,
      originalLang: null,
      title: 'शीर्षक',
      summary: 'सारांश',
      content: '<p>यह हिन्दी सामग्री है</p>',
      translations: {},
    };

    let callCount = 0;
    Article.updateOne = async () => {
      callCount++;
      return { acknowledged: true, modifiedCount: 1 };
    };
    Article.findOne = () => ({ lean: async () => story });

    const res = await request(app).get('/api/public/stories/test-story-2?lang=en');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // At least one translate call should include source:'hi'
    assert.ok(fetchBodies.some((b) => b && b.source === 'hi'), 'should use detected source lang hi');
    assert.ok(callCount >= 2, 'should lock + persist');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('GET /api/public/stories/:slug does not crash when translation fails (falls back)', async () => {
  const originals = { findOne: Article.findOne, updateOne: Article.updateOne };
  const prevFetch = global.fetch;

  global.fetch = async () => {
    throw new Error('boom');
  };

  try {
    const story = {
      _id: '507f1f77bcf86cd799439013',
      slug: 'test-story-3',
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      translations: {},
    };

    let callCount = 0;
    Article.updateOne = async () => {
      callCount++;
      return { acknowledged: true, modifiedCount: 1 };
    };
    Article.findOne = () => ({ lean: async () => story });

    const res = await request(app).get('/api/public/stories/test-story-3?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.title, 'Hello');
    assert.equal(res.body.data.summary, 'Summary');
    assert.equal(res.body.data.content, '<p>Body</p>');
    assert.equal(res.body.translationPending, true);
    assert.ok(callCount >= 1, 'should attempt lock (and may persist failure state)');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});
