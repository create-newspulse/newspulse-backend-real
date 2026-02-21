const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('DELETE /api/admin/articles/:id/forever (permanent delete)', async (t) => {
  await t.test('401 when unauthenticated', async () => {
    const res = await request(app)
      .delete('/api/admin/articles/507f1f77bcf86cd799439011/forever')
      .send();
    assert.equal(res.statusCode, 401);
  });

  await t.test('200 + {success:true} when status is deleted', async () => {
    const id = '64b7f2f2f2f2f2f2f2f2f2f2';
    const originals = { findById: News.findById, deleteOne: News.deleteOne };

    News.findById = async (_id) => (_id === id ? { _id: id, status: 'deleted' } : null);
    let called = false;
    News.deleteOne = async (cond) => {
      if (cond && String(cond._id) === id) called = true;
      return { acknowledged: true, deletedCount: 1 };
    };

    const res = await request(app)
      .delete(`/api/admin/articles/${id}/forever`)
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true });
    assert.equal(called, true);

    restore(originals);
  });

  await t.test('400 when status is not deleted', async () => {
    const id = '64b7f2f2f2f2f2f2f2f2f2f3';
    const originals = { findById: News.findById, deleteOne: News.deleteOne };

    News.findById = async (_id) => (_id === id ? { _id: id, status: 'draft' } : null);
    let called = false;
    News.deleteOne = async () => {
      called = true;
      return { acknowledged: true, deletedCount: 0 };
    };

    const res = await request(app)
      .delete(`/api/admin/articles/${id}/forever`)
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send();

    assert.equal(res.statusCode, 400);
    assert.equal(called, false);

    restore(originals);
  });
});

test('CORS preflight allows DELETE + OPTIONS for admin + local origins (articles forever)', async () => {
  const paths = [
    { origin: 'https://admin.newspulse.co.in', path: '/api/admin/articles/507f1f77bcf86cd799439011/forever' },
    { origin: 'http://localhost:9999', path: '/api/admin/articles/507f1f77bcf86cd799439011/forever' },
  ];

  for (const p of paths) {
    const res = await request(app)
      .options(p.path)
      .set('Origin', p.origin)
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
      .expect(204);

    assert.equal(res.headers['access-control-allow-origin'], p.origin);

    const methods = String(res.headers['access-control-allow-methods'] || '');
    assert.ok(methods.includes('DELETE'));
    assert.ok(methods.includes('OPTIONS'));
  }
});
