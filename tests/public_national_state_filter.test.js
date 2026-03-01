const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const News = require('../models/News');

process.env.NODE_ENV = 'test';
const app = require('../server');

function makeChainableQuery(items, capture) {
  return {
    sort(arg) {
      capture.sortArg = arg;
      return this;
    },
    skip(n) {
      capture.skip = n;
      return this;
    },
    limit(n) {
      capture.limit = n;
      return this;
    },
    lean: async () => items,
  };
}

test('GET /api/articles/national/state/:stateSlug filters published national by stateTags (200)', async () => {
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  const capture = { query: null, sortArg: null, skip: null, limit: null };

  try {
    const dataset = [
      { _id: '1', title: 't1', description: 'd', content: 'c', category: 'national', status: 'published', stateTags: ['gujarat'] },
      { _id: '2', title: 't2', description: 'd', content: 'c', category: 'national', status: 'published', stateTags: ['gujarat', 'delhi'] },
    ];

    News.find = (q) => {
      capture.query = q;
      return makeChainableQuery(dataset, capture);
    };
    News.countDocuments = async (q) => {
      // should match the same query
      assert.deepEqual(q, capture.query);
      return dataset.length;
    };

    const res = await request(app)
      .get('/api/articles/national/state/gujarat?page=1&limit=20');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.stateSlug, 'gujarat');
    assert.equal(res.body.data.total, 2);

    assert.deepEqual(capture.query, { status: 'published', category: 'national', stateTags: 'gujarat' });
    assert.deepEqual(capture.sortArg, { publishedAt: -1, createdAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('GET /api/articles/national/state/:stateSlug rejects invalid slug (400)', async () => {
  const res = await request(app)
    .get('/api/articles/national/state/not-a-real-state');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});
