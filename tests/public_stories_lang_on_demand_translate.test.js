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
      slugs: { hi: 'test-story-hi' },
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>', provider: 'google', generatedAt: new Date().toISOString() },
      },
      translationStatus: { hi: 'ready' },
    };

    Article.findOne = () => ({
      sort() { return this; },
      lean: async () => story,
    });

    const res = await request(app).get('/api/public/stories/test-story-hi?lang=hi');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.title, 'नमस्ते');
    assert.equal(res.body.data.summary, 'सारांश');
    assert.equal(res.body.data.content, '<p>शरीर</p>');
    assert.equal(res.body.requestedLang, 'hi');
    assert.equal(res.body.resolvedLang, 'hi');
    assert.equal(updateCalls, 0);
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories/:slug?lang=hi returns 404 when translation is missing (strict locale)', async () => {
  const originals = { findOne: Article.findOne };
  try {
    const story = {
      _id: '507f1f77bcf86cd799439012',
      slug: 'test-story-2',
      slugs: { hi: 'test-story-2-hi' },
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      translations: {},
      translationStatus: {},
    };

    Article.findOne = () => ({
      sort() { return this; },
      lean: async () => story,
    });

    const res = await request(app).get('/api/public/stories/test-story-2-hi?lang=hi');
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'LOCALE_NOT_AVAILABLE');
    assert.equal(res.body.requestedLang, 'hi');
    assert.ok(Array.isArray(res.body.availableLocales));
    assert.ok(res.body.availableLocales.includes('en'));
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories/:slug?lang=hi allows explicit fallback to en when allowFallback=1', async () => {
  const originals = { findOne: Article.findOne };
  try {
    const story = {
      _id: '507f1f77bcf86cd799439013',
      slug: 'test-story-3',
      slugs: { hi: 'test-story-3-hi' },
      status: 'published',
      language: 'en',
      originalLang: 'en',
      title: 'Hello',
      summary: 'Summary',
      content: '<p>Body</p>',
      translations: {},
      translationStatus: {},
    };

    Article.findOne = () => ({
      sort() { return this; },
      lean: async () => story,
    });

    const res = await request(app).get('/api/public/stories/test-story-3-hi?lang=hi&allowFallback=1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.requestedLang, 'hi');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.data.title, 'Hello');
  } finally {
    restore(originals);
  }
});
