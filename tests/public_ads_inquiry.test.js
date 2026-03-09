const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.ADS_INQUIRY_TO = 'ads-team@example.com';
process.env.ADS_INQUIRY_FROM = 'no-reply@newspulse.ai';

const app = require('../server');

const AdInquiry = require('../models/AdInquiry');
const adsMailer = require('../utils/mailer');

test('POST /api/public/ads/inquiry stores inquiry and triggers email (best-effort)', async () => {
  const prevCreate = AdInquiry.create;
  const prevSend = adsMailer.sendAdsInquiryMail;

  const fixedId = '507f1f77bcf86cd799439011';
  const fixedCreatedAt = new Date('2025-01-01T00:00:00.000Z');

  let createArgs = null;
  let mailArgs = null;

  AdInquiry.create = async (doc) => {
    createArgs = doc;
    return { _id: fixedId, createdAt: fixedCreatedAt };
  };

  adsMailer.sendAdsInquiryMail = async (opts) => {
    mailArgs = opts;
    return { messageId: 'test-message-id' };
  };

  try {
    const res = await request(app)
      .post('/api/public/ads/inquiry')
      .set('User-Agent', 'unit-test-agent')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'Hello there' });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { success: true, id: fixedId, emailSent: true });

    assert.ok(createArgs);
    assert.equal(createArgs.name, 'Alice');
    assert.equal(createArgs.email, 'alice@example.com');
    assert.equal(createArgs.message, 'Hello there');
    assert.equal(createArgs.status, 'new');
    assert.ok(!('meta' in createArgs));

    assert.ok(mailArgs);
    assert.equal(mailArgs.name, 'Alice');
    assert.equal(mailArgs.email, 'alice@example.com');
    assert.equal(mailArgs.message, 'Hello there');
    assert.equal(String(mailArgs.inquiryId), fixedId);
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('POST /api/public/ads/inquiry rejects invalid email', async () => {
  const res = await request(app)
    .post('/api/public/ads/inquiry')
    .send({ name: 'Alice', email: 'not-an-email', message: 'Hello' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Invalid email');
});
