const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GRIEVANCE_TO_EMAIL = 'grievance@newspulse.co.in';
process.env.GRIEVANCE_SMTP_HOST = 'mail.newspulse.co.in';
process.env.GRIEVANCE_SMTP_PORT = '465';
process.env.GRIEVANCE_SMTP_SECURE = 'true';
process.env.GRIEVANCE_SMTP_USER = 'grievance@newspulse.co.in';
process.env.GRIEVANCE_SMTP_PASS = 'test-pass';

const app = require('../server');
const grievanceMailer = require('../lib/grievanceMailer');

function buildPayload(overrides = {}) {
  return {
    fullName: 'Alice Example',
    email: 'alice@example.com',
    phone: '+91 98765 43210',
    address: '221B Test Street\nAhmedabad',
    contentReference: 'https://newspulse.co.in/news/example-story',
    publicationDate: '2026-05-10',
    violationPart: 'Article paragraph 3',
    violationSummary: 'The reported statement is inaccurate and defamatory.',
    declarationAccepted: true,
    ...overrides,
  };
}

test('POST /api/public/grievance sanitizes input and sends grievance mail', async () => {
  const prevSend = grievanceMailer.sendGrievanceMail;
  let mailArgs = null;

  grievanceMailer.sendGrievanceMail = async (payload) => {
    mailArgs = payload;
    return { messageId: 'grievance-message-id' };
  };

  try {
    const res = await request(app)
      .post('/api/public/grievance')
      .set('x-forwarded-for', '203.0.113.12')
      .send(buildPayload({
        fullName: ' Alice <b>Example</b> ',
        violationSummary: ' <script>alert(1)</script>Statement is false. ',
      }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: 'Grievance submitted successfully.' });
    assert.ok(mailArgs);
    assert.equal(mailArgs.fullName, 'Alice Example');
    assert.equal(mailArgs.email, 'alice@example.com');
    assert.equal(mailArgs.violationSummary, 'Statement is false.');
    assert.equal(mailArgs.requestIp, '203.0.113.12');
    assert.equal(mailArgs.declarationAccepted, true);
  } finally {
    grievanceMailer.sendGrievanceMail = prevSend;
  }
});

test('POST /api/public/grievance rejects invalid payload with generic failure response', async () => {
  const prevSend = grievanceMailer.sendGrievanceMail;
  let sendCalled = false;

  grievanceMailer.sendGrievanceMail = async () => {
    sendCalled = true;
    return { messageId: 'unexpected' };
  };

  try {
    const res = await request(app)
      .post('/api/public/grievance')
      .send(buildPayload({ email: 'bad-email', declarationAccepted: false, phone: '123' }));

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, message: 'Unable to submit grievance right now.' });
    assert.equal(sendCalled, false);
  } finally {
    grievanceMailer.sendGrievanceMail = prevSend;
  }
});

test('POST /api/public/grievance rejects filled honeypot field with generic failure response', async () => {
  const prevSend = grievanceMailer.sendGrievanceMail;
  let sendCalled = false;

  grievanceMailer.sendGrievanceMail = async () => {
    sendCalled = true;
    return { messageId: 'unexpected' };
  };

  try {
    const res = await request(app)
      .post('/api/public/grievance')
      .send(buildPayload({ websiteUrl: 'https://spam.example.com' }));

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, message: 'Unable to submit grievance right now.' });
    assert.equal(sendCalled, false);
  } finally {
    grievanceMailer.sendGrievanceMail = prevSend;
  }
});

test('POST /api/public/grievance rate limits repeated submissions from the same IP', async () => {
  const prevSend = grievanceMailer.sendGrievanceMail;
  let sendCount = 0;

  grievanceMailer.sendGrievanceMail = async () => {
    sendCount += 1;
    return { messageId: `grievance-${sendCount}` };
  };

  try {
    for (let index = 0; index < 5; index += 1) {
      const res = await request(app)
        .post('/api/public/grievance')
        .set('x-forwarded-for', '203.0.113.99')
        .send(buildPayload({ email: `alice${index}@example.com` }));

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true, message: 'Grievance submitted successfully.' });
    }

    const limited = await request(app)
      .post('/api/public/grievance')
      .set('x-forwarded-for', '203.0.113.99')
      .send(buildPayload({ email: 'alice-final@example.com' }));

    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.body, { success: false, message: 'Unable to submit grievance right now.' });
    assert.equal(sendCount, 5);
  } finally {
    grievanceMailer.sendGrievanceMail = prevSend;
  }
});

test('POST /api/public/grievance hides internal mailer failures from the client', async () => {
  const prevSend = grievanceMailer.sendGrievanceMail;

  grievanceMailer.sendGrievanceMail = async () => {
    throw new Error('smtp auth failed for grievance mailbox');
  };

  try {
    const res = await request(app)
      .post('/api/public/grievance')
      .set('x-forwarded-for', '203.0.113.150')
      .send(buildPayload({ email: 'failure@example.com' }));

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { success: false, message: 'Unable to submit grievance right now.' });
  } finally {
    grievanceMailer.sendGrievanceMail = prevSend;
  }
});