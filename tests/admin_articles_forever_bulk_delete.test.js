const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('POST /api/admin/articles/forever/bulk requires auth (401)', async () => {
  const res = await request(app)
    .post('/api/admin/articles/forever/bulk')
    .send({ ids: ['507f1f77bcf86cd799439011'] });

  assert.equal(res.statusCode, 401);
});

test('POST /api/admin/articles/forever/bulk validates ids array (400)', async () => {
  const res1 = await request(app)
    .post('/api/admin/articles/forever/bulk')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({});
  assert.equal(res1.statusCode, 400);

  const res2 = await request(app)
    .post('/api/admin/articles/forever/bulk')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ ids: [] });
  assert.equal(res2.statusCode, 400);

  const res3 = await request(app)
    .post('/api/admin/articles/forever/bulk')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ ids: ['not-an-objectid'] });
  assert.equal(res3.statusCode, 400);
});

test('POST /api/admin/articles/forever/bulk deletes only status=deleted and returns deletedCount', async () => {
  const originals = {
    deleteMany: News.deleteMany,
  };

  let calledWith = null;
  try {
    News.deleteMany = async (filter) => {
      calledWith = filter;
      return { acknowledged: true, deletedCount: 2 };
    };

    const ids = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];

    const res = await request(app)
      .post('/api/admin/articles/forever/bulk')
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send({ ids });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, deletedCount: 2 });

    assert.ok(calledWith);
    assert.equal(calledWith.status, 'deleted');
    assert.ok(calledWith._id && calledWith._id.$in);
    assert.deepEqual(calledWith._id.$in, ids);
  } finally {
    restore(originals);
  }
});

test('DELETE /api/admin/articles/forever/all-deleted deletes all soft-deleted and returns deletedCount', async () => {
  const originals = {
    deleteMany: News.deleteMany,
  };

  let calledWith = null;
  try {
    News.deleteMany = async (filter) => {
      calledWith = filter;
      return { acknowledged: true, deletedCount: 5 };
    };

    const res = await request(app)
      .delete('/api/admin/articles/forever/all-deleted')
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, deletedCount: 5 });

    assert.deepEqual(calledWith, { status: 'deleted' });
  } finally {
    restore(originals);
  }
});
