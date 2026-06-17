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
  const res = await request(app).get('/api/admin/ads/inquiries');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('GET /admin-api/ads/inquiries lists inquiries with JWT and supports status filter', async () => {
  const prevFind = AdInquiry.find;
  const prevCount = AdInquiry.countDocuments;

  const fake = [
    {
      _id: '507f1f77bcf86cd799439099',
      inquiryId: 'ADQ-20250102-ABC123',
      advertiserName: 'Buyer',
      companyName: 'ACME Media',
      name: 'Buyer',
      email: 'buyer@example.com',
      phone: '+91 9999999999',
      message: 'Need pricing',
      budget: '25000',
      campaignType: 'Display',
      preferredAdSlot: 'HOME_728x90',
      campaignGoal: 'Traffic',
      preferredDates: 'Next month',
      source: 'advertise-with-us',
      status: 'new',
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
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
      .get('/api/admin/ads/inquiries?status=new&page=1&limit=20')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, '507f1f77bcf86cd799439099');
    assert.equal(res.body.items[0].inquiryId, 'ADQ-20250102-ABC123');
    assert.equal(res.body.items[0].advertiserName, 'Buyer');
    assert.equal(res.body.items[0].companyName, 'ACME Media');
    assert.equal(res.body.items[0].phone, '+91 9999999999');
    assert.equal(res.body.items[0].budget, '25000');
    assert.equal(res.body.items[0].campaignType, 'Display');
    assert.equal(res.body.items[0].preferredAdSlot, 'HOME_728x90');
    assert.equal(res.body.items[0].campaignGoal, 'Traffic');
    assert.equal(res.body.items[0].preferredDates, 'Next month');
    assert.equal(res.body.items[0].source, 'advertise-with-us');
    assert.equal(res.body.items[0].status, 'new');
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
    assert.equal(res.body.total, 1);

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
      .get('/api/admin/ads/inquiries/unread-count')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, unread: 7 });
  } finally {
    AdInquiry.countDocuments = prevCount;
  }
});

test('PATCH /admin-api/ads/inquiries/:id/mark-read marks inquiry as read', async () => {
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
        };
      },
    };
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .patch(`/api/admin/ads/inquiries/${id}/mark-read`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true });

    assert.equal(updateArgs.$set.status, 'read');
    assert.ok(updateArgs.$set.readAt);
    assert.deepEqual(optsArgs, { new: true, runValidators: true });
  } finally {
    AdInquiry.findByIdAndUpdate = prevUpdate;
  }
});

test('DELETE /admin-api/ads/inquiries/:id soft-deletes inquiry', async () => {
  const prevUpdate = AdInquiry.findByIdAndUpdate;

  const id = '507f1f77bcf86cd799439056';
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
          status: 'deleted',
          createdAt: new Date('2025-01-02T00:00:00.000Z'),
        };
      },
    };
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .delete(`/api/admin/ads/inquiries/${id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true });

    assert.equal(updateArgs.$set.status, 'deleted');
    assert.ok(updateArgs.$set.deletedAt);
    assert.deepEqual(optsArgs, { new: true, runValidators: true });
  } finally {
    AdInquiry.findByIdAndUpdate = prevUpdate;
  }
});
