const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('GET /api/public/articles honors x-lang header and localizes from cached translations', async () => {
  const originals = { find: News.find, countDocuments: News.countDocuments };
  try {
    const doc = {
      _id: '507f1f77bcf86cd799439099',
      status: 'published',
      category: 'national',
      language: 'gu',
      originalLang: 'gu',
      title: 'હેલો',
      description: 'સારાંશ',
      content: '<p>શરીર</p>',
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>' },
      },
      translationStatus: {
        hi: 'ready',
      },
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    News.find = (_query) => ({
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => [doc],
    });

    News.countDocuments = async () => 1;

    const res = await request(app)
      .get('/api/public/articles?limit=1&page=1')
      .set('x-lang', 'hi');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data && Array.isArray(res.body.data.items), true);
    assert.equal(res.body.data.items.length, 1);

    const out = res.body.data.items[0];
    assert.equal(out.title, 'नमस्ते');
    assert.equal(out.description, 'सारांश');
    assert.equal(out.summary, 'सारांश');
    assert.equal(out.content, '<p>शरीर</p>');
    assert.equal(out.language, 'hi');
  } finally {
    restore(originals);
  }
});
