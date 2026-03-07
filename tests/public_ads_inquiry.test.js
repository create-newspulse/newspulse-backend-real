const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.ADS_INQUIRY_TO = 'ads-team@example.com';
process.env.ADS_INQUIRY_FROM = 'no-reply@newspulse.ai';

const app = require('../server');

const AdInquiry = require('../models/AdInquiry');
const mailer = require('../lib/mailer');

test('POST /api/public/ads/inquiry stores inquiry and triggers email (best-effort)', async () => {
  const prevCreate = AdInquiry.create;
  const prevSendMail = mailer.sendMail;

  const fixedId = '507f1f77bcf86cd799439011';
  const fixedCreatedAt = new Date('2025-01-01T00:00:00.000Z');

  let createArgs = null;
  let mailArgs = null;

  AdInquiry.create = async (doc) => {
    createArgs = doc;
    return { _id: fixedId, createdAt: fixedCreatedAt };
  };

  mailer.sendMail = async (opts) => {
    mailArgs = opts;
    return { messageId: 'test-message-id' };
  };

  try {
    const res = await request(app)
      .post('/api/public/ads/inquiry')
      .set('User-Agent', 'unit-test-agent')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'Hello there' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, id: fixedId });

    assert.ok(createArgs);
    assert.equal(createArgs.name, 'Alice');
    assert.equal(createArgs.email, 'alice@example.com');
    assert.equal(createArgs.message, 'Hello there');
    assert.equal(createArgs.status, 'new');
    assert.equal(createArgs.userAgent, 'unit-test-agent');

    assert.ok(mailArgs);
    assert.equal(mailArgs.to, 'ads-team@example.com');
    assert.equal(mailArgs.from, 'no-reply@newspulse.ai');
    assert.equal(mailArgs.replyTo, 'alice@example.com');
    assert.equal(typeof mailArgs.subject, 'string');
    assert.ok(mailArgs.subject.includes('New Ad Inquiry'));
    assert.equal(typeof mailArgs.text, 'string');
    assert.ok(mailArgs.text.includes('Name: Alice'));
    assert.ok(mailArgs.text.includes('Email: alice@example.com'));
    assert.ok(mailArgs.text.includes('Message:'));
    assert.ok(mailArgs.text.includes('Hello there'));
    assert.ok(mailArgs.text.includes(`InquiryId: ${fixedId}`));
  } finally {
    AdInquiry.create = prevCreate;
    mailer.sendMail = prevSendMail;
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
