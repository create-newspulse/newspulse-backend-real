const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
const app = require('../server');
const News = require('../models/News');

// Success: hard delete when status=deleted
test('DELETE /api/articles/:id/hard-delete permanently deletes when status=deleted', async () => {
  const id = '64b7f2f2f2f2f2f2f2f2f2f2';
  const originals = { findById: News.findById, deleteOne: News.deleteOne };
  News.findById = async (_id) => (_id === id ? { _id: id, status: 'deleted' } : null);
  let called = false;
  News.deleteOne = async (cond) => { if (String(cond._id) === id) called = true; return { acknowledged: true, deletedCount: 1 }; };

  const res = await request(app).delete(`/api/articles/${id}/hard-delete`).send();
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.message, 'Article permanently deleted.');
  assert.ok(called);
  News.findById = originals.findById; News.deleteOne = originals.deleteOne;
});

// Guard: not deleted -> 400
test('DELETE /api/articles/:id/hard-delete returns 400 if not deleted', async () => {
  const id = '64b7f2f2f2f2f2f2f2f2f2f3';
  const originals = { findById: News.findById, deleteOne: News.deleteOne };
  News.findById = async (_id) => (_id === id ? { _id: id, status: 'draft' } : null);
  let called = false; News.deleteOne = async () => { called = true; return { acknowledged: true, deletedCount: 0 }; };

  const res = await request(app).delete(`/api/articles/${id}/hard-delete`).send();
  assert.strictEqual(res.statusCode, 400);
  assert.ok(!called);
  News.findById = originals.findById; News.deleteOne = originals.deleteOne;
});
