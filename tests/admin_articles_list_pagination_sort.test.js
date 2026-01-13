const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const News = require('../models/News');

// Ensure we load the app in test/import mode (server.js already skips DB when imported)
process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

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

test('GET /api/articles supports page=0 and sort=-updatedAt (returns 200)', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  const capture = { sortArg: null, skip: null, limit: null };

  try {
    // Some codepaths check readiness; keep it simple.
    mongoose.connection.readyState = 1;

    const dataset = [
      { title: 'a', description: 'd', updatedAt: new Date('2025-01-02T00:00:00Z') },
      { title: 'b', description: 'd', updatedAt: new Date('2025-01-01T00:00:00Z') },
    ];

    News.find = () => makeChainableQuery(dataset, capture);
    News.countDocuments = async () => dataset.length;

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .get('/api/articles?page=0&limit=20&sort=-updatedAt')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.page, 1, 'page should clamp to 1');
    assert.equal(res.body.limit, 20);

    // Ensure our handler converted the sort string into a safe sort object.
    assert.deepEqual(capture.sortArg, { updatedAt: -1 });
    assert.equal(capture.skip, 0);
    assert.equal(capture.limit, 20);
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('GET /admin-api/admin/articles supports page=0 and sort=-updatedAt (returns 200)', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  const capture = { sortArg: null, skip: null, limit: null };

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      { title: 'a', description: 'd', updatedAt: new Date('2025-01-02T00:00:00Z') },
      { title: 'b', description: 'd', updatedAt: new Date('2025-01-01T00:00:00Z') },
    ];

    News.find = () => makeChainableQuery(dataset, capture);
    News.countDocuments = async () => dataset.length;

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .get('/admin-api/admin/articles?page=0&limit=20&sort=-updatedAt')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.page, 1, 'page should clamp to 1');
    assert.equal(res.body.limit, 20);
    assert.deepEqual(capture.sortArg, { updatedAt: -1 });
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});
