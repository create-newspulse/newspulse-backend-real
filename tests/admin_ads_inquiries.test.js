const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const jwt = require('jsonwebtoken');

const app = require('../server');
const AdInquiry = require('../models/AdInquiry');

function makeFindResult(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return items; },
  };
}

function makeToken() {
  return jwt.sign(
    { sub: '507f1f77bcf86cd799439012', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

test('GET /admin-api/ads/inquiries returns 401 when unauthenticated', async () => {
  const res = await request(app).get('/admin-api/ads/inquiries');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('GET /admin-api/ads/inquiries lists inquiries with JWT and supports status filter', async () => {
  const prevFind = AdInquiry.find;
  const prevCount = AdInquiry.countDocuments;

  const fake = [
    {
      _id: '507f1f77bcf86cd799439099',
      name: 'Buyer',
      email: 'buyer@example.com',
      message: 'Need pricing',
      status: 'new',
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
      ip: '127.0.0.1',
      userAgent: 'ua',
    },
  ];

  let lastFindFilter = null;
  let lastCountFilter = null;

  AdInquiry.find = (filter) => {
    lastFindFilter = filter;
    return makeFindResult(fake);
  };
  AdInquiry.countDocuments = async (filter) => {
    lastCountFilter = filter;
    return fake.length;
  };

  try {
    const token = makeToken();

    const res = await request(app)
      .get('/admin-api/ads/inquiries?status=new&page=1&limit=20')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, '507f1f77bcf86cd799439099');
    assert.equal(res.body.items[0].status, 'new');

    assert.deepEqual(lastFindFilter, { status: 'new' });
    assert.deepEqual(lastCountFilter, { status: 'new' });
  } finally {
    AdInquiry.find = prevFind;
    AdInquiry.countDocuments = prevCount;
  }
});

test('GET /admin-api/ads/inquiries/unread-count returns count of new inquiries', async () => {
  const prevCount = AdInquiry.countDocuments;
  AdInquiry.countDocuments = async (filter) => {
    assert.deepEqual(filter, { status: 'new' });
    return 7;
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .get('/admin-api/ads/inquiries/unread-count')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { count: 7 });
  } finally {
    AdInquiry.countDocuments = prevCount;
  }
});

test('PATCH /admin-api/ads/inquiries/:id/read marks inquiry as read', async () => {
  const prevUpdate = AdInquiry.findByIdAndUpdate;

  const id = '507f1f77bcf86cd799439055';
  let updateArgs = null;
  let optsArgs = null;

  AdInquiry.findByIdAndUpdate = (passedId, update, opts) => {
    updateArgs = update;
    optsArgs = opts;
    assert.equal(passedId, id);

    return {
      async lean() {
        return {
          _id: id,
          name: 'Buyer',
          email: 'buyer@example.com',
          message: 'Need pricing',
          status: 'read',
          createdAt: new Date('2025-01-02T00:00:00.000Z'),
          ip: null,
          userAgent: null,
        };
      },
    };
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .patch(`/admin-api/ads/inquiries/${id}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true });

    assert.deepEqual(updateArgs, { $set: { status: 'read' } });
    assert.deepEqual(optsArgs, { new: true });
  } finally {
    AdInquiry.findByIdAndUpdate = prevUpdate;
  }
});
