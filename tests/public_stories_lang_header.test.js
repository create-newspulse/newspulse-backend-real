const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const Article = require('../models/Article');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) Article[k] = v;
}

test('GET /api/public/stories/:slug honors x-lang header when query lang is absent', async () => {
  const originals = { findOne: Article.findOne };
  try {
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
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>' },
      },
    };

    Article.findOne = () => ({
      sort() { return this; },
      lean: async () => story,
    });

    const res = await request(app)
      .get('/api/public/stories/test-story-hi')
      .set('x-lang', 'hi');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.title, 'नमस्ते');
    assert.equal(res.body.data.summary, 'सारांश');
    assert.equal(res.body.data.content, '<p>शरीर</p>');
  } finally {
    restore(originals);
  }
});

test('GET /api/public/stories honors x-lang header for feed filtering/localization', async () => {
  const originals = { find: Article.find };
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
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>' },
      },
    };

    Article.find = () => ({
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => [story],
    });

    const res = await request(app)
      .get('/api/public/stories?limit=1&page=1')
      .set('x-lang', 'hi');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(Array.isArray(res.body.data), true);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].title, 'नमस्ते');
    assert.equal(res.body.data[0].summary, 'सारांश');
    assert.equal(res.body.data[0].content, '<p>शरीर</p>');
  } finally {
    restore(originals);
  }
});
