const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const jwt = require('jsonwebtoken');

const app = require('../server');
const AdInquiry = require('../models/AdInquiry');

function makeToken() {
  return jwt.sign(
    { sub: '507f1f77bcf86cd799439012', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeFindLeanResult(items) {
  return { async lean() { return items; } };
}

test('Bulk endpoints require auth (401)', async () => {
  const id = '507f1f77bcf86cd799439056';
  assert.equal((await request(app).patch('/api/ads/inquiries/bulk/read').send({ ids: [id] })).statusCode, 401);
  assert.equal((await request(app).patch('/api/ads/inquiries/bulk/trash').send({ ids: [id] })).statusCode, 401);
  assert.equal((await request(app).patch('/api/ads/inquiries/bulk/restore').send({ ids: [id] })).statusCode, 401);
  assert.equal((await request(app).delete('/api/ads/inquiries/bulk/permanent').send({ ids: [id] })).statusCode, 401);
});

test('PATCH /api/ads/inquiries/bulk/read validates ids and ignores invalid', async () => {
  const token = makeToken();

  const bad = await request(app)
    .patch('/api/ads/inquiries/bulk/read')
    .set('Authorization', `Bearer ${token}`)
    .send({ ids: [] });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.success, false);

  const prevUpdateMany = AdInquiry.updateMany;
  let seenFilter = null;

  AdInquiry.updateMany = async (filter, update) => {
    seenFilter = filter;
    assert.equal(update.$set.status, 'read');
    assert.equal(update.$set.isRead, true);
    return { modifiedCount: 1 };
  };

  try {
    const res = await request(app)
      .patch('/api/ads/inquiries/bulk/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439056', 'not-an-id'] });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.processed, 1);
    assert.ok(String(res.body.message || '').length > 0);
    assert.equal(Array.isArray(seenFilter._id.$in), true);
    assert.equal(seenFilter._id.$in.length, 1);
  } finally {
    AdInquiry.updateMany = prevUpdateMany;
  }
});

test('PATCH /api/ads/inquiries/bulk/trash uses bulkWrite and returns processed count', async () => {
  const token = makeToken();

  const prevFind = AdInquiry.find;
  const prevBulkWrite = AdInquiry.bulkWrite;

  AdInquiry.find = () => makeFindLeanResult([
    { _id: '507f1f77bcf86cd799439056', status: 'new', isRead: false },
    { _id: '507f1f77bcf86cd799439057', status: 'read', isRead: true },
    { _id: '507f1f77bcf86cd799439058', status: 'deleted', isRead: true },
  ]);

  let opsLen = 0;
  AdInquiry.bulkWrite = async (ops) => {
    opsLen = ops.length;
    return { ok: 1 };
  };

  try {
    const res = await request(app)
      .patch('/api/ads/inquiries/bulk/trash')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439056', '507f1f77bcf86cd799439057', '507f1f77bcf86cd799439058'] });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.processed, 2);
    assert.ok(String(res.body.message || '').length > 0);
    assert.equal(opsLen, 2);
  } finally {
    AdInquiry.find = prevFind;
    AdInquiry.bulkWrite = prevBulkWrite;
  }
});

test('PATCH /api/ads/inquiries/bulk/restore uses bulkWrite and returns processed count', async () => {
  const token = makeToken();

  const prevFind = AdInquiry.find;
  const prevBulkWrite = AdInquiry.bulkWrite;

  AdInquiry.find = () => makeFindLeanResult([
    { _id: '507f1f77bcf86cd799439056', status: 'deleted', previousStatus: 'new', isRead: false },
    { _id: '507f1f77bcf86cd799439057', status: 'deleted', previousStatus: 'read', isRead: true, readAt: new Date() },
    { _id: '507f1f77bcf86cd799439058', status: 'new', isRead: false },
  ]);

  let opsLen = 0;
  AdInquiry.bulkWrite = async (ops) => {
    opsLen = ops.length;
    return { ok: 1 };
  };

  try {
    const res = await request(app)
      .patch('/api/ads/inquiries/bulk/restore')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439056', '507f1f77bcf86cd799439057', '507f1f77bcf86cd799439058'] });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.processed, 2);
    assert.ok(String(res.body.message || '').length > 0);
    assert.equal(opsLen, 2);
  } finally {
    AdInquiry.find = prevFind;
    AdInquiry.bulkWrite = prevBulkWrite;
  }
});

test('DELETE /api/ads/inquiries/bulk/permanent deletes many and returns deletedCount', async () => {
  const token = makeToken();

  const prevCountDocuments = AdInquiry.countDocuments;
  const prevDeleteMany = AdInquiry.deleteMany;

  let seenCountFilter = null;
  let seenDeleteFilter = null;
  AdInquiry.countDocuments = async (filter) => {
    seenCountFilter = filter;
    return 2;
  };

  AdInquiry.deleteMany = async (filter) => {
    seenDeleteFilter = filter;
    return { deletedCount: 2 };
  };

  try {
    const res = await request(app)
      .delete('/api/ads/inquiries/bulk/permanent')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439056', '507f1f77bcf86cd799439057'] });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Inquiries deleted permanently');
    assert.equal(res.body.processed, 2);
    assert.equal(res.body.deletedCount, 2);
    assert.equal(seenCountFilter.status, 'deleted');
    assert.equal(seenDeleteFilter.status, 'deleted');
  } finally {
    AdInquiry.countDocuments = prevCountDocuments;
    AdInquiry.deleteMany = prevDeleteMany;
  }
});

test('DELETE /api/ads/inquiries/bulk/permanent returns 200 with processed=0 when nothing matches', async () => {
  const token = makeToken();

  const prevCountDocuments = AdInquiry.countDocuments;
  const prevDeleteMany = AdInquiry.deleteMany;

  AdInquiry.countDocuments = async () => 0;
  AdInquiry.deleteMany = async () => ({ deletedCount: 0 });

  try {
    const res = await request(app)
      .delete('/api/ads/inquiries/bulk/permanent')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439056'] });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.processed, 0);
    assert.equal(res.body.deletedCount, 0);
    assert.ok(String(res.body.message || '').length > 0);
  } finally {
    AdInquiry.countDocuments = prevCountDocuments;
    AdInquiry.deleteMany = prevDeleteMany;
  }
});

test('DELETE /api/ads/inquiries/bulk/permanent returns 400 when ids are invalid', async () => {
  const token = makeToken();

  const res = await request(app)
    .delete('/api/ads/inquiries/bulk/permanent')
    .set('Authorization', `Bearer ${token}`)
    .send({ ids: ['not-an-id'] });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.processed, 0);
  assert.equal(res.body.deletedCount, 0);
  assert.ok(String(res.body.message || '').length > 0);
});
