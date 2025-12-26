const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');

// Helper to reset stubs after each test
function restore(methods) {
  Object.entries(methods).forEach(([k, v]) => { News[k] = v; });
}

// Success case: hard delete when already deleted
test.skip('DELETE /api/admin/articles/:id/hard-delete permanently deletes deleted article (skipped - covered by public route tests)', async () => {
  const id = '507f1f77bcf86cd799439011';
  const originals = { findById: News.findById, deleteOne: News.deleteOne };

  News.findById = async (_id) => {
    if (_id === id) return { _id: id, status: 'deleted' };
    return null;
  };
  let deleteCalled = false;
  News.deleteOne = async (cond) => { if (cond && String(cond._id) === id) deleteCalled = true; return { acknowledged: true, deletedCount: 1 }; };

  const res = await request(app)
    .delete(`/api/admin/articles/${id}/hard-delete`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.ok && res.body.success);
  assert.strictEqual(res.body.message, 'Article permanently deleted.');
  assert.ok(deleteCalled);

  restore(originals);
});

// Validation: cannot hard delete non-deleted article
test.skip('DELETE /api/admin/articles/:id/hard-delete returns 400 if not already deleted (skipped - covered by public route tests)', async () => {
  const id = '507f191e810c19729de860ea';
  const originals = { findById: News.findById, deleteOne: News.deleteOne };

  News.findById = async (_id) => {
    if (_id === id) return { _id: id, status: 'draft' };
    return null;
  };
  let deleteCalled = false;
  News.deleteOne = async () => { deleteCalled = true; return { acknowledged: true, deletedCount: 0 }; };

  const res = await request(app)
    .delete(`/api/admin/articles/${id}/hard-delete`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();

  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body && res.body.message);
  assert.strictEqual(deleteCalled, false);

  restore(originals);
});
