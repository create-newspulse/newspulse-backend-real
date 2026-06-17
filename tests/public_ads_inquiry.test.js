const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.ADS_INQUIRY_TO = 'ads-team@example.com';
process.env.ADS_INQUIRY_FROM = 'no-reply@newspulse.ai';

const app = require('../server');

const AdInquiry = require('../models/AdInquiry');
const adsMailer = require('../utils/mailer');
const { CANONICAL_AD_OPPORTUNITIES } = require('../src/constants/adSlots');

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
      .send({
        name: 'Alice',
        company: 'ACME Corp',
        email: 'alice@example.com',
        phone: '+91 9876543210',
        campaignType: 'Display',
        preferredAdSlot: 'HOME_728x90',
        campaignGoal: 'Brand awareness',
        preferredDates: '2026-07-01 to 2026-07-15',
        budget: '50000',
        message: 'Hello there',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.id, fixedId);
    assert.match(res.body.inquiryId, /^ADQ-\d{8}-[A-Z0-9]{6}$/);

    assert.ok(createArgs);
    assert.equal(createArgs.inquiryId, res.body.inquiryId);
    assert.equal(createArgs.advertiserName, 'Alice');
    assert.equal(createArgs.name, 'Alice');
    assert.equal(createArgs.companyName, 'ACME Corp');
    assert.equal(createArgs.email, 'alice@example.com');
    assert.equal(createArgs.phone, '+91 9876543210');
    assert.equal(createArgs.campaignType, 'Display');
    assert.equal(createArgs.preferredAdSlot, 'HOME_728x90');
    assert.equal(createArgs.campaignGoal, 'Brand awareness');
    assert.equal(createArgs.preferredDates, '2026-07-01 to 2026-07-15');
    assert.equal(createArgs.budget, '50000');
    assert.equal(createArgs.message, 'Hello there');
    assert.equal(createArgs.status, 'new');
    assert.equal(createArgs.source, 'advertise-with-us');
    assert.ok(createArgs.meta);
    assert.equal(createArgs.meta.userAgent, 'unit-test-agent');

    assert.ok(mailArgs);
    assert.equal(mailArgs.name, 'Alice');
    assert.equal(mailArgs.companyName, 'ACME Corp');
    assert.equal(mailArgs.email, 'alice@example.com');
    assert.equal(mailArgs.phone, '+91 9876543210');
    assert.equal(mailArgs.campaignType, 'Display');
    assert.equal(mailArgs.preferredAdSlot, 'HOME_728x90');
    assert.equal(mailArgs.campaignGoal, 'Brand awareness');
    assert.equal(mailArgs.preferredDates, '2026-07-01 to 2026-07-15');
    assert.equal(mailArgs.budget, '50000');
    assert.equal(mailArgs.message, 'Hello there');
    assert.equal(String(mailArgs.inquiryId), res.body.inquiryId);
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('POST /api/public/ads/inquiry rejects invalid email', async () => {
  const res = await request(app)
    .post('/api/public/ads/inquiry')
    .send({
      name: 'Alice',
      company: 'ACME Corp',
      email: 'not-an-email',
      phone: '+91 9876543210',
      campaignType: 'Display',
      preferredAdSlot: 'HOME_728x90',
      campaignGoal: 'Leads',
      preferredDates: 'Next month',
      budget: '50000',
      message: 'Hello',
    });

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
        company: 'Bob Media',
        email: 'newspulse.ads@gmail.com',
        advertiserEmail: 'bob@example.com',
        phone: '+91 9999999999',
        campaignType: 'Video',
        preferredAdSlot: 'COMBO_CAMPAIGN',
        campaignGoal: 'Reach',
        preferredDates: 'Flexible',
        budget: '100000',
        message: 'Need pricing',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.id, fixedId);
    assert.match(res.body.inquiryId, /^ADQ-\d{8}-[A-Z0-9]{6}$/);

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
        company: 'NewsPulse Test Media',
        email: 'test@example.com',
        phone: '+91 8888888888',
        campaignType: 'Display',
        preferredAdSlot: 'HOME_728x90',
        campaignGoal: 'Traffic',
        preferredDates: '1 Jul 2026 - 7 Jul 2026',
        budget: '25000',
        message: 'Hello News Pulse Ads Team,\\n\\nI want to run a 7-day campaign.\\n\\nThanks',
        pageUrl: 'https://newspulse.co.in/advertise',
        source: 'advertise-page',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.id, fixedId);
    assert.match(res.body.inquiryId, /^ADQ-\d{8}-[A-Z0-9]{6}$/);
    assert.equal(createArgs.advertiserName, 'Kiran Test');
    assert.equal(createArgs.name, 'Kiran Test');
    assert.equal(createArgs.companyName, 'NewsPulse Test Media');
    assert.equal(createArgs.email, 'test@example.com');
    assert.equal(createArgs.phone, '+91 8888888888');
    assert.equal(createArgs.campaignType, 'Display');
    assert.equal(createArgs.preferredAdSlot, 'HOME_728x90');
    assert.equal(createArgs.placement, 'HOME_728x90');
    assert.equal(createArgs.campaignGoal, 'Traffic');
    assert.equal(createArgs.preferredDates, '1 Jul 2026 - 7 Jul 2026');
    assert.equal(createArgs.budget, '25000');
    assert.equal(createArgs.status, 'new');
    assert.equal(createArgs.isRead, false);
    assert.equal(createArgs.pageUrl, 'https://newspulse.co.in/advertise');
    assert.equal(createArgs.source, 'advertise-with-us');
    assert.equal(createArgs.message, 'Hello News Pulse Ads Team,\n\nI want to run a 7-day campaign.\n\nThanks');

    assert.equal(mailArgs.name, 'Kiran Test');
    assert.equal(mailArgs.companyName, 'NewsPulse Test Media');
    assert.equal(mailArgs.email, 'test@example.com');
    assert.equal(mailArgs.phone, '+91 8888888888');
    assert.equal(mailArgs.campaignType, 'Display');
    assert.equal(mailArgs.preferredAdSlot, 'HOME_728x90');
    assert.equal(mailArgs.placement, 'HOME_728x90');
    assert.equal(mailArgs.campaignGoal, 'Traffic');
    assert.equal(mailArgs.preferredDates, '1 Jul 2026 - 7 Jul 2026');
    assert.equal(mailArgs.budget, '25000');
    assert.equal(mailArgs.pageUrl, 'https://newspulse.co.in/advertise');
    assert.equal(mailArgs.message, 'Hello News Pulse Ads Team,\n\nI want to run a 7-day campaign.\n\nThanks');
    assert.equal(mailArgs.source, 'advertise-with-us');
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
      .send({
        name: 'Email Fail Test',
        company: 'Fail Co',
        email: 'fail@example.com',
        phone: '+91 7777777777',
        campaignType: 'Display',
        preferredAdSlot: 'HOME_728x90',
        campaignGoal: 'Leads',
        preferredDates: 'Flexible',
        budget: '1000',
        message: 'Please send me ad rates',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.id, fixedId);
    assert.equal(res.body.warning, 'email_failed');
    assert.match(res.body.inquiryId, /^ADQ-\d{8}-[A-Z0-9]{6}$/);
    assert.equal(createCalled, true);
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('POST /api/public/ads/inquiry preserves all canonical ad opportunity keys and combo alias', async () => {
  const prevCreate = AdInquiry.create;
  const prevSend = adsMailer.sendAdsInquiryMail;
  const placements = [];
  const mailPlacements = [];

  AdInquiry.create = async (doc) => {
    placements.push(doc.placement);
    return { _id: `507f1f77bcf86cd7994390${String(placements.length).padStart(2, '0')}`, createdAt: new Date('2026-04-30T08:00:00.000Z') };
  };
  adsMailer.sendAdsInquiryMail = async (opts) => {
    mailPlacements.push(opts.placement);
    return { messageId: `message-${mailPlacements.length}` };
  };

  try {
    for (const [index, placement] of CANONICAL_AD_OPPORTUNITIES.entries()) {
      const res = await request(app)
        .post('/api/public/ads/inquiry')
        .set('x-forwarded-for', `203.0.113.${index + 1}`)
        .send({
          name: 'Opportunity Test',
          company: 'Opportunity Co',
          email: 'opportunity@example.com',
          phone: '+91 7000000000',
          campaignType: 'Display',
          preferredAdSlot: placement,
          campaignGoal: 'Leads',
          preferredDates: 'Next quarter',
          budget: '10000',
          message: 'Please send rates',
        });

      assert.equal(res.statusCode, 201);
    }

    const aliasRes = await request(app)
      .post('/api/public/ads/inquiry')
      .set('x-forwarded-for', '203.0.113.250')
      .send({
        name: 'Opportunity Test',
        company: 'Opportunity Co',
        email: 'opportunity@example.com',
        phone: '+91 7000000000',
        campaignType: 'Display',
        preferredAdSlot: 'SPONSORED_FEATURE_ARTICLE_COMBO',
        campaignGoal: 'Leads',
        preferredDates: 'Next quarter',
        budget: '10000',
        message: 'Please send rates',
      });

    assert.equal(aliasRes.statusCode, 201);
    assert.deepEqual(placements.slice(0, CANONICAL_AD_OPPORTUNITIES.length), CANONICAL_AD_OPPORTUNITIES);
    assert.deepEqual(mailPlacements.slice(0, CANONICAL_AD_OPPORTUNITIES.length), CANONICAL_AD_OPPORTUNITIES);
    assert.equal(placements.at(-1), 'COMBO_CAMPAIGN');
    assert.equal(mailPlacements.at(-1), 'COMBO_CAMPAIGN');
  } finally {
    AdInquiry.create = prevCreate;
    adsMailer.sendAdsInquiryMail = prevSend;
  }
});

test('OPTIONS /api/public/ads/inquiry returns public ad inquiry CORS headers for allowed frontend origins', async () => {
  const res = await request(app)
    .options('/api/public/ads/inquiry')
    .set('Origin', 'http://localhost:3000')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'Content-Type');

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.match(String(res.headers['access-control-allow-methods'] || ''), /POST/);
});

test('POST /api/public/ads/inquiry requires the advertise-with-us fields', async () => {
  const res = await request(app)
    .post('/api/public/ads/inquiry')
    .send({
      name: 'Alice',
      company: 'ACME Corp',
      email: 'alice@example.com',
      phone: '+91 9876543210',
      preferredAdSlot: 'HOME_728x90',
      campaignGoal: 'Brand awareness',
      preferredDates: '2026-07-01 to 2026-07-15',
      budget: '50000',
      message: 'Hello there',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Missing required field: campaignType');
});
