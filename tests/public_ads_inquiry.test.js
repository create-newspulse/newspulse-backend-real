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
    assert.deepEqual(res.body, { ok: true, success: true, id: fixedId });

    assert.ok(createArgs);
    assert.equal(createArgs.advertiserName, 'Alice');
    assert.equal(createArgs.name, 'Alice');
    assert.equal(createArgs.email, 'alice@example.com');
    assert.equal(createArgs.message, 'Hello there');
    assert.equal(createArgs.status, 'new');
    assert.ok(createArgs.meta);
    assert.equal(createArgs.meta.userAgent, 'unit-test-agent');

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

test('POST /api/public/ads/inquiry prefers advertiserEmail when email matches internal inbox', async () => {
  const prevCreate = AdInquiry.create;
  const prevSend = adsMailer.sendAdsInquiryMail;

  // Simulate a miswired frontend sending internal inbox in `email`.
  process.env.ADS_INQUIRY_TO = 'newspulse.ads@gmail.com';

  const fixedId = '507f1f77bcf86cd799439012';
  const fixedCreatedAt = new Date('2025-01-03T00:00:00.000Z');

  let createArgs = null;
  let mailArgs = null;

  AdInquiry.create = async (doc) => {
    createArgs = doc;
    return { _id: fixedId, createdAt: fixedCreatedAt };
  };

  adsMailer.sendAdsInquiryMail = async (opts) => {
    mailArgs = opts;
    return { messageId: 'test-message-id-2' };
  };

  try {
    const res = await request(app)
      .post('/api/public/ads/inquiry')
      .send({
        name: 'Bob',
        email: 'newspulse.ads@gmail.com',
        advertiserEmail: 'bob@example.com',
        message: 'Need pricing',
      });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { ok: true, success: true, id: fixedId });

    assert.ok(createArgs);
    assert.equal(createArgs.email, 'bob@example.com');
    assert.ok(mailArgs);
    assert.equal(mailArgs.email, 'bob@example.com');
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('POST /api/public/ad-inquiries stores normalized public advertise inquiry with clean newlines', async () => {
  const prevCreate = AdInquiry.create;
  const prevSend = adsMailer.sendAdsInquiryMail;

  const fixedId = '507f1f77bcf86cd799439013';
  const fixedCreatedAt = new Date('2026-04-29T08:30:00.000Z');
  let createArgs = null;
  let mailArgs = null;

  AdInquiry.create = async (doc) => {
    createArgs = doc;
    return { _id: fixedId, createdAt: fixedCreatedAt };
  };
  adsMailer.sendAdsInquiryMail = async (opts) => {
    mailArgs = opts;
    return { messageId: 'acceptance-message-id' };
  };

  try {
    const res = await request(app)
      .post('/api/public/ad-inquiries')
      .send({
        name: 'Kiran Test',
        email: 'test@example.com',
        slot: 'HOME_728x90',
        message: 'Hello News Pulse Ads Team,\\n\\nI want to run a 7-day campaign.\\n\\nThanks',
        pageUrl: 'https://newspulse.co.in/advertise',
        source: 'advertise-page',
      });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { ok: true, success: true, id: fixedId });
    assert.equal(createArgs.advertiserName, 'Kiran Test');
    assert.equal(createArgs.name, 'Kiran Test');
    assert.equal(createArgs.email, 'test@example.com');
    assert.equal(createArgs.placement, 'HOME_728x90');
    assert.equal(createArgs.status, 'new');
    assert.equal(createArgs.isRead, false);
    assert.equal(createArgs.pageUrl, 'https://newspulse.co.in/advertise');
    assert.equal(createArgs.source, 'advertise-page');
    assert.equal(createArgs.message, 'Hello News Pulse Ads Team,\n\nI want to run a 7-day campaign.\n\nThanks');

    assert.equal(mailArgs.name, 'Kiran Test');
    assert.equal(mailArgs.email, 'test@example.com');
    assert.equal(mailArgs.placement, 'HOME_728x90');
    assert.equal(mailArgs.pageUrl, 'https://newspulse.co.in/advertise');
    assert.equal(mailArgs.message, 'Hello News Pulse Ads Team,\n\nI want to run a 7-day campaign.\n\nThanks');
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('POST /api/public/ad-inquiries keeps saved inquiry when notification email fails', async () => {
  const prevCreate = AdInquiry.create;
  const prevSend = adsMailer.sendAdsInquiryMail;

  const fixedId = '507f1f77bcf86cd799439014';
  let createCalled = false;

  AdInquiry.create = async () => {
    createCalled = true;
    return { _id: fixedId, createdAt: new Date('2026-04-29T08:35:00.000Z') };
  };
  adsMailer.sendAdsInquiryMail = async () => {
    throw new Error('SMTP unavailable');
  };

  try {
    const res = await request(app)
      .post('/api/public/ad-inquiries')
      .send({ name: 'Email Fail Test', email: 'fail@example.com', message: 'Please send me ad rates' });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, { ok: true, success: true, id: fixedId, warning: 'email_failed' });
    assert.equal(createCalled, true);
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});
