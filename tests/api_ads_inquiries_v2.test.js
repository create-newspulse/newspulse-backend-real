const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const jwt = require('jsonwebtoken');

const app = require('../server');
const AdInquiry = require('../models/AdInquiry');
const AuditLog = require('../models/AuditLog');

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

test('GET /api/ads/inquiries returns 401 when unauthenticated', async () => {
  const res = await request(app).get('/api/ads/inquiries');
  assert.equal(res.statusCode, 401);
});

test('GET /api/ads/inquiries returns {success, items, total} with admin JWT', async () => {
  const prevFind = AdInquiry.find;
  const prevCount = AdInquiry.countDocuments;

  const fake = [
    {
      _id: '507f1f77bcf86cd799439099',
      inquiryId: 'ADQ-20250102-ABC123',
      advertiserName: 'Buyer',
      companyName: 'ACME',
      email: 'buyer@example.com',
      phone: '+1 555 111 2222',
      message: 'Need pricing',
      budget: '1000',
      campaignType: 'Display',
      preferredAdSlot: 'HOME_728x90',
      campaignGoal: 'Reach',
      preferredDates: 'Next month',
      placement: 'homepage',
      source: 'advertise-with-us',
      status: 'new',
      isRead: false,
      hasReply: true,
      replyCount: 2,
      lastRepliedAt: new Date('2025-01-04T00:00:00.000Z'),
      lastRepliedBy: 'admin@newspulse.ai',
      lastReplySubject: 'Pricing follow-up',
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    },
  ];

  AdInquiry.find = (filter) => {
    assert.ok(filter);
    return makeFindResult(fake);
  };
  AdInquiry.countDocuments = async (_filter) => fake.length;

  try {
    const token = makeToken();
    const res = await request(app)
      .get('/api/ads/inquiries?limit=20&search=buyer')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0]._id, '507f1f77bcf86cd799439099');
    assert.equal(res.body.items[0].inquiryId, 'ADQ-20250102-ABC123');
    assert.equal(res.body.items[0].campaignType, 'Display');
    assert.equal(res.body.items[0].preferredAdSlot, 'HOME_728x90');
    assert.equal(res.body.items[0].campaignGoal, 'Reach');
    assert.equal(res.body.items[0].preferredDates, 'Next month');
    assert.equal(res.body.items[0].source, 'advertise-with-us');
    assert.equal(res.body.items[0].hasReply, true);
    assert.equal(res.body.items[0].replyCount, 2);
    assert.equal(res.body.items[0].lastRepliedBy, 'admin@newspulse.ai');
    assert.equal(res.body.items[0].lastReplySubject, 'Pricing follow-up');
    assert.equal(res.body.total, 1);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.pages, 1);
  } finally {
    AdInquiry.find = prevFind;
    AdInquiry.countDocuments = prevCount;
  }
});

test('GET /api/ads/inquiries?status=new uses pure status filter', async () => {
  const prevFind = AdInquiry.find;
  const prevCount = AdInquiry.countDocuments;

  let seenFilter = null;
  AdInquiry.find = (filter) => {
    seenFilter = filter;
    return makeFindResult([]);
  };
  AdInquiry.countDocuments = async () => 0;

  try {
    const token = makeToken();
    const res = await request(app)
      .get('/api/ads/inquiries?status=new&page=1&limit=20&search=')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenFilter, { status: 'new' });
    assert.equal(res.body.total, 0);
  } finally {
    AdInquiry.find = prevFind;
    AdInquiry.countDocuments = prevCount;
  }
});

test('GET /api/ads/inquiries/:id returns full stable detail payload with no UI action fields', async () => {
  const prevFindById = AdInquiry.findById;

  const id = '507f1f77bcf86cd799439111';
  const fake = {
    _id: id,
    inquiryId: 'ADQ-20250102-ABC123',
    advertiserName: 'Buyer',
    companyName: 'ACME',
    email: 'buyer@example.com',
    phone: '+1 555 111 2222',
    message: 'Need pricing',
    budget: '1000',
    campaignType: 'Display',
    preferredAdSlot: 'HOME_728x90',
    campaignGoal: 'Reach',
    preferredDates: 'Next month',
    source: 'advertise-with-us',
    status: 'read',
    isRead: true,
    hasReply: true,
    replyCount: 1,
    lastRepliedAt: new Date('2025-01-04T00:00:00.000Z'),
    lastRepliedBy: 'admin@newspulse.ai',
    lastReplySubject: 'Pricing',
    replyHistory: [
      {
        subject: 'Pricing',
        repliedAt: new Date('2025-01-04T00:00:00.000Z'),
        repliedBy: 'admin@newspulse.ai',
      },
    ],
    createdAt: new Date('2025-01-02T00:00:00.000Z'),
    updatedAt: new Date('2025-01-03T00:00:00.000Z'),
  };

  AdInquiry.findById = (passedId) => {
    assert.equal(String(passedId), id);
    return {
      async lean() {
        return fake;
      },
    };
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .get(`/api/ads/inquiries/${id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.item._id, id);
    assert.equal(res.body.item.inquiryId, 'ADQ-20250102-ABC123');
    assert.equal(res.body.item.advertiserName, 'Buyer');
    assert.equal(res.body.item.companyName, 'ACME');
    assert.equal(res.body.item.email, 'buyer@example.com');
    assert.equal(res.body.item.phone, '+1 555 111 2222');
    assert.equal(res.body.item.message, 'Need pricing');
    assert.equal(res.body.item.budget, '1000');
    assert.equal(res.body.item.campaignType, 'Display');
    assert.equal(res.body.item.preferredAdSlot, 'HOME_728x90');
    assert.equal(res.body.item.campaignGoal, 'Reach');
    assert.equal(res.body.item.preferredDates, 'Next month');
    assert.equal(res.body.item.source, 'advertise-with-us');
    assert.equal(res.body.item.status, 'read');
    assert.equal(res.body.item.isRead, true);
    assert.equal(res.body.item.hasReply, true);
    assert.equal(res.body.item.replyCount, 1);
    assert.equal(res.body.item.lastRepliedBy, 'admin@newspulse.ai');
    assert.equal(res.body.item.lastReplySubject, 'Pricing');
    assert.equal(Array.isArray(res.body.item.replyHistory), true);
    assert.equal(res.body.item.replyHistory.length, 1);
    assert.ok(res.body.item.createdAt);
    assert.ok(res.body.item.updatedAt);
    assert.equal('mailtoLabel' in res.body.item, false);
    assert.equal('actionButtons' in res.body.item, false);
    assert.equal('uiActions' in res.body.item, false);
  } finally {
    AdInquiry.findById = prevFindById;
  }
});

test('GET /api/ads/inquiries/unread-count returns {success, unreadCount}', async () => {
  const prevCount = AdInquiry.countDocuments;
  AdInquiry.countDocuments = async (_filter) => 7;

  try {
    const token = makeToken();
    const res = await request(app)
      .get('/api/ads/inquiries/unread-count')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, unreadCount: 7 });
  } finally {
    AdInquiry.countDocuments = prevCount;
  }
});

test('PATCH /api/ads/inquiries/:id/trash requires auth and soft-deletes', async () => {
  const id = '507f1f77bcf86cd799439056';

  // unauth
  const unauth = await request(app).patch(`/api/ads/inquiries/${id}/trash`);
  assert.equal(unauth.statusCode, 401);

  const prevFindById = AdInquiry.findById;
  const prevUpdate = AdInquiry.findByIdAndUpdate;

  AdInquiry.findById = (passedId) => {
    assert.equal(String(passedId), id);
    return {
      async lean() {
        return { _id: id, status: 'new', isRead: false };
      },
    };
  };

  let updateArgs = null;
  AdInquiry.findByIdAndUpdate = (_id, update, _opts) => {
    updateArgs = update;
    return { async lean() { return { _id: id }; } };
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .patch(`/api/ads/inquiries/${id}/trash`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Inquiry moved to trash' });
    assert.equal(updateArgs.$set.status, 'deleted');
  } finally {
    AdInquiry.findById = prevFindById;
    AdInquiry.findByIdAndUpdate = prevUpdate;
  }
});

test('PATCH /api/ads/inquiries/:id/restore requires auth and restores', async () => {
  const id = '507f1f77bcf86cd799439057';

  const unauth = await request(app).patch(`/api/ads/inquiries/${id}/restore`);
  assert.equal(unauth.statusCode, 401);

  const prevFindById = AdInquiry.findById;
  const prevUpdate = AdInquiry.findByIdAndUpdate;

  AdInquiry.findById = (_id) => ({
    async lean() {
      return { _id: id, status: 'deleted', previousStatus: 'read', isRead: true, readAt: new Date() };
    },
  });
  AdInquiry.findByIdAndUpdate = (_id, _update, _opts) => ({ async lean() { return { _id: id }; } });

  try {
    const token = makeToken();
    const res = await request(app)
      .patch(`/api/ads/inquiries/${id}/restore`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Inquiry restored' });
  } finally {
    AdInquiry.findById = prevFindById;
    AdInquiry.findByIdAndUpdate = prevUpdate;
  }
});

test('DELETE /api/ads/inquiries/:id/permanent requires auth and hard-deletes', async () => {
  const id = '507f1f77bcf86cd799439058';

  const unauth = await request(app).delete(`/api/ads/inquiries/${id}/permanent`);
  assert.equal(unauth.statusCode, 401);

  const prevDelete = AdInquiry.findByIdAndDelete;
  const prevAuditCreate = AuditLog.create;
  let auditDoc = null;

  AdInquiry.findByIdAndDelete = (_id) => ({
    async lean() {
      return { _id: id, advertiserName: 'Buyer', email: 'buyer@example.com', status: 'deleted' };
    },
  });
  AuditLog.create = async (doc) => {
    auditDoc = doc;
    return doc;
  };

  try {
    const token = makeToken();
    const res = await request(app)
      .delete(`/api/ads/inquiries/${id}/permanent`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Inquiry deleted permanently', deletedCount: 1 });
    assert.ok(auditDoc);
    assert.equal(auditDoc.action, 'permanent_delete');
    assert.equal(auditDoc.key, `ads_inquiry:${id}`);
    assert.equal(auditDoc.actor.email, 'admin@newspulse.ai');
    assert.equal(auditDoc.meta.inquiryId, id);
    assert.equal(auditDoc.meta.advertiserName, 'Buyer');
    assert.equal(auditDoc.meta.advertiserEmail, 'buyer@example.com');
    assert.equal(auditDoc.meta.deletedBy, 'admin@newspulse.ai');
  } finally {
    AdInquiry.findByIdAndDelete = prevDelete;
    AuditLog.create = prevAuditCreate;
  }
});

test('DELETE /api/ads/inquiries/:id is non-ambiguous (405 guidance)', async () => {
  const id = '507f1f77bcf86cd799439059';
  const token = makeToken();
  const res = await request(app)
    .delete(`/api/ads/inquiries/${id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.success, false);
  assert.ok(String(res.body.message || '').includes('/trash'));
  assert.ok(String(res.body.message || '').includes('/permanent'));
});
