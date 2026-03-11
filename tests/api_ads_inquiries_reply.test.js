const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const jwt = require('jsonwebtoken');

const app = require('../server');
const AdInquiry = require('../models/AdInquiry');
const adsMailer = require('../utils/mailer');

function makeToken() {
  return jwt.sign(
    { sub: '507f1f77bcf86cd799439012', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

test('POST /api/ads/inquiries/:id/reply returns 401 when unauthenticated', async () => {
  const res = await request(app)
    .post('/api/ads/inquiries/507f1f77bcf86cd799439011/reply')
    .send({ subject: 'Hi', message: 'Hello' });

  assert.equal(res.statusCode, 401);
});

test('POST /api/ads/inquiries/:id/reply sends email and returns success', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439011';

  const prevFindById = AdInquiry.findById;
  const prevSend = adsMailer.sendAdsReplyMail;

  AdInquiry.findById = (passedId) => {
    assert.equal(String(passedId), id);
    return {
      async lean() {
        return { _id: id, email: 'buyer@example.com', advertiserName: 'Buyer' };
      },
    };
  };

  let mailArgs = null;
  adsMailer.sendAdsReplyMail = async (opts) => {
    mailArgs = opts;
    return { messageId: 'test-reply-message-id' };
  };

  try {
    const res = await request(app)
      .post(`/api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Pricing', message: 'Thanks for reaching out.' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Reply sent successfully' });

    assert.ok(mailArgs);
    assert.equal(mailArgs.to, 'buyer@example.com');
    assert.equal(mailArgs.subject, 'Pricing');
    assert.equal(mailArgs.message, 'Thanks for reaching out.');
    assert.equal(String(mailArgs.inquiryId), id);
    assert.equal(mailArgs.admin.email, 'admin@newspulse.ai');
  } finally {
    AdInquiry.findById = prevFindById;
    adsMailer.sendAdsReplyMail = prevSend;
  }
});

test('POST /admin-api/ads/inquiries/:id/reply is mounted (alias path)', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439016';

  const prevFindById = AdInquiry.findById;
  const prevSend = adsMailer.sendAdsReplyMail;

  AdInquiry.findById = (_id) => ({
    async lean() {
      return { _id: id, email: 'buyer@example.com' };
    },
  });

  adsMailer.sendAdsReplyMail = async () => ({ messageId: 'alias-ok' });

  try {
    const res = await request(app)
      .post(`/admin-api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Hello', message: 'Test' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Reply sent successfully' });
  } finally {
    AdInquiry.findById = prevFindById;
    adsMailer.sendAdsReplyMail = prevSend;
  }
});

test('POST /api/ads/inquiries/:id/reply returns 503 when SMTP is not configured', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439017';

  const prevFindById = AdInquiry.findById;
  const prevSend = adsMailer.sendAdsReplyMail;

  AdInquiry.findById = (_id) => ({
    async lean() {
      return { _id: id, email: 'buyer@example.com' };
    },
  });

  adsMailer.sendAdsReplyMail = async () => {
    throw new Error('Ads SMTP not configured');
  };

  try {
    const res = await request(app)
      .post(`/api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Hello', message: 'Test' });

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'ADS_SMTP_NOT_CONFIGURED');
  } finally {
    AdInquiry.findById = prevFindById;
    adsMailer.sendAdsReplyMail = prevSend;
  }
});

test('POST /api/ads/inquiries/:id/reply rejects invalid id', async () => {
  const token = makeToken();
  const res = await request(app)
    .post('/api/ads/inquiries/not-an-id/reply')
    .set('Authorization', `Bearer ${token}`)
    .send({ subject: 'Hi', message: 'Hello' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('POST /api/ads/inquiries/:id/reply returns 404 when inquiry is missing', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439015';

  const prevFindById = AdInquiry.findById;
  AdInquiry.findById = (_id) => ({
    async lean() {
      return null;
    },
  });

  try {
    const res = await request(app)
      .post(`/api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Hi', message: 'Hello' });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { success: false, message: 'Inquiry not found' });
  } finally {
    AdInquiry.findById = prevFindById;
  }
});

test('POST /api/ads/inquiries/:id/reply rejects invalid advertiser email', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439013';

  const prevFindById = AdInquiry.findById;
  AdInquiry.findById = (_id) => ({
    async lean() {
      return { _id: id, email: 'not-an-email' };
    },
  });

  try {
    const res = await request(app)
      .post(`/api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Hi', message: 'Hello' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'Valid advertiser email not found');
  } finally {
    AdInquiry.findById = prevFindById;
  }
});

test('POST /api/ads/inquiries/:id/reply blocks internal inbox recipient', async () => {
  const token = makeToken();
  const id = '507f1f77bcf86cd799439014';

  process.env.ADS_INQUIRY_TO = 'newspulse.ads@gmail.com';

  const prevFindById = AdInquiry.findById;
  const prevSend = adsMailer.sendAdsReplyMail;

  AdInquiry.findById = (_id) => ({
    async lean() {
      return { _id: id, email: 'newspulse.ads@gmail.com' };
    },
  });

  let sendCalled = false;
  adsMailer.sendAdsReplyMail = async () => {
    sendCalled = true;
    return { messageId: 'should-not-send' };
  };

  try {
    const res = await request(app)
      .post(`/api/ads/inquiries/${id}/reply`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Hi', message: 'Hello' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'Valid advertiser email not found');
    assert.equal(sendCalled, false);
  } finally {
    AdInquiry.findById = prevFindById;
    adsMailer.sendAdsReplyMail = prevSend;
  }
});
