const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');

test('GET /api/public/trending-topics returns defaults when DB not ready', async () => {
  const prev = mongoose.connection.readyState;
  try {
    mongoose.connection.readyState = 0;

    const res = await request(app).get('/api/public/trending-topics');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data);
    assert.ok(Array.isArray(res.body.data.items));
    assert.ok(res.body.data.items.length > 0);
  } finally {
    mongoose.connection.readyState = prev;
  }
});
