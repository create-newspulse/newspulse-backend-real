const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('POST /api/public/news/:id/translate returns 400 for invalid target lang', async () => {
  const res = await request(app)
    .post('/api/public/news/507f1f77bcf86cd799439011/translate')
    .send({ lang: 'fr' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('POST /api/public/news/:id/translate returns 404 when doc not found or not published', async () => {
  const originals = { findById: News.findById };
  try {
    News.findById = async () => null;

    const res1 = await request(app)
      .post('/api/public/news/507f1f77bcf86cd799439011/translate')
      .send({ lang: 'hi' });
    assert.equal(res1.statusCode, 404);

    News.findById = async () => ({
      _id: '507f1f77bcf86cd799439011',
      status: 'draft',
      toObject: () => ({ _id: '507f1f77bcf86cd799439011', status: 'draft' }),
    });

    const res2 = await request(app)
      .post('/api/public/news/507f1f77bcf86cd799439011/translate')
      .send({ lang: 'hi' });
    assert.equal(res2.statusCode, 404);
  } finally {
    restore(originals);
  }
});

test('POST /api/public/news/:id/translate returns cached translations when present', async () => {
  const originals = { findById: News.findById };
  const prevFetch = global.fetch;

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    throw new Error('should not call fetch when cached');
  };

  try {
    const doc = {
      _id: '507f1f77bcf86cd799439011',
      status: 'published',
      translations: {
        hi: { title: 't', summary: 's', content: 'c' },
      },
      toObject: () => ({
        _id: '507f1f77bcf86cd799439011',
        status: 'published',
        translations: { hi: { title: 't', summary: 's', content: 'c' } },
      }),
    };

    News.findById = async () => doc;

    const res = await request(app)
      .post('/api/public/news/507f1f77bcf86cd799439011/translate')
      .send({ lang: 'hi' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.activeLang, 'hi');
    assert.equal(fetchCalls, 0);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('POST /api/public/news/:id/translate generates translation, saves, and returns activeLang', async () => {
  const originals = { findById: News.findById };
  const prevFetch = global.fetch;

  let saved = false;
  let fetchCalls = 0;
  global.fetch = async (_url, opts) => {
    fetchCalls++;
    const body = JSON.parse(String(opts && opts.body ? opts.body : '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          translations: q.map((txt) => ({ translatedText: `T:${txt}` })),
        },
      }),
    };
  };

  try {
    const doc = {
      _id: '507f1f77bcf86cd799439011',
      status: 'published',
      lang: 'en',
      title: 'Hello',
      description: 'Summary',
      content: 'Body',
      translations: {},
      save: async () => { saved = true; },
      toObject: () => ({
        _id: '507f1f77bcf86cd799439011',
        status: 'published',
        translations: doc.translations,
        title: 'Hello',
        description: 'Summary',
        content: 'Body',
      }),
    };

    News.findById = async () => doc;

    const res = await request(app)
      .post('/api/public/news/507f1f77bcf86cd799439011/translate')
      .send({ lang: 'hi' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.activeLang, 'hi');
    assert.equal(saved, true);

    assert.ok(doc.translations && doc.translations.hi);
    assert.equal(doc.translations.hi.title, 'T:Hello');
    assert.equal(doc.translations.hi.summary, 'T:Summary');
    assert.equal(doc.translations.hi.content, 'T:Body');

    // 3 calls (title/summary/content), each is a v2 request.
    assert.equal(fetchCalls, 3);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});
