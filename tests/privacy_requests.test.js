const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const {
  PRIVACY_REQUESTS_FILE,
  DPDP_AUDIT_LOGS_FILE,
} = require('../services/privacyRequestStore');

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '[]\n';
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validPayload(overrides = {}) {
  return {
    fullName: 'Alice Privacy',
    email: 'alice.privacy@example.com',
    mobile: '+91 98765 43210',
    requestType: 'access',
    message: 'Please provide access to the personal data associated with this email address.',
    referenceId: 'ARTICLE-123',
    ...overrides,
  };
}

async function withRestoredDpdpFiles(fn) {
  const originalRequests = readFileSafe(PRIVACY_REQUESTS_FILE);
  const originalAuditLogs = readFileSafe(DPDP_AUDIT_LOGS_FILE);
  writeJson(PRIVACY_REQUESTS_FILE, []);
  writeJson(DPDP_AUDIT_LOGS_FILE, []);
  try {
    await fn();
  } finally {
    fs.writeFileSync(PRIVACY_REQUESTS_FILE, originalRequests, 'utf8');
    fs.writeFileSync(DPDP_AUDIT_LOGS_FILE, originalAuditLogs, 'utf8');
  }
}

test('POST /api/privacy/request stores pending request without exposing verification token', async () => {
  await withRestoredDpdpFiles(async () => {
    const res = await request(app)
      .post('/api/privacy/request')
      .set('x-forwarded-for', '203.0.113.201')
      .send(validPayload({ email: 'alice.201@example.com' }));

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.match(res.body.requestId, /^DPDP-\d{8}-[A-F0-9]{8}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'verificationToken'), false);

    const stored = JSON.parse(fs.readFileSync(PRIVACY_REQUESTS_FILE, 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].requestId, res.body.requestId);
    assert.equal(stored[0].source, 'Frontend Form');
    assert.equal(stored[0].status, 'Pending Email Verification');
    assert.equal(typeof stored[0].verificationTokenHash, 'string');
    assert.equal(stored[0].verificationTokenHash.length, 64);
    assert.ok(stored[0].verificationTokenExpiresAt);
  });
});

test('GET /api/privacy/verify/:token verifies request and writes audit log', async () => {
  await withRestoredDpdpFiles(async () => {
    const token = 'known-test-token';
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-VERIFY01',
        fullName: 'Verifier User',
        email: 'verify@example.com',
        mobile: null,
        requestType: 'correction',
        message: 'Please correct my profile details.',
        referenceId: null,
        source: 'Frontend Form',
        status: 'Pending Email Verification',
        verificationTokenHash: hashToken(token),
        verificationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        verifiedAt: null,
        adminNote: null,
        handledBy: null,
        replySentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const res = await request(app)
      .get(`/api/privacy/verify/${token}`)
      .set('Accept', 'application/json');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Your privacy request has been verified and will be reviewed by News Pulse.');

    const stored = JSON.parse(fs.readFileSync(PRIVACY_REQUESTS_FILE, 'utf8'));
    assert.equal(stored[0].status, 'Verified');
    assert.equal(stored[0].verificationTokenHash, null);
    assert.ok(stored[0].verifiedAt);

    const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].requestId, 'DPDP-20260703-VERIFY01');
    assert.equal(auditLogs[0].action, 'privacy_request_verified');
    assert.equal(auditLogs[0].oldStatus, 'Pending Email Verification');
    assert.equal(auditLogs[0].newStatus, 'Verified');
  });
});

test('admin DPDP routes require auth and default list excludes pending email verification', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-PENDING1',
        fullName: 'Pending User',
        email: 'pending@example.com',
        requestType: 'access',
        message: 'Pending request message.',
        source: 'Frontend Form',
        status: 'Pending Email Verification',
        createdAt: '2026-07-03T10:00:00.000Z',
        updatedAt: '2026-07-03T10:00:00.000Z',
      },
      {
        requestId: 'DPDP-20260703-VERIFIED1',
        fullName: 'Verified User',
        email: 'verified@example.com',
        requestType: 'deletion',
        message: 'Verified request message.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T11:00:00.000Z',
        updatedAt: '2026-07-03T11:00:00.000Z',
      },
    ]);

    const unauthorized = await request(app).get('/api/admin/dpdp/privacy-requests');
    assert.equal(unauthorized.statusCode, 401);

    const defaultList = await request(app)
      .get('/api/admin/dpdp/privacy-requests')
      .set('Cookie', 'np_admin=founder@example.com');
    assert.equal(defaultList.statusCode, 200);
    assert.deepEqual(defaultList.body.requests.map((item) => item.requestId), ['DPDP-20260703-VERIFIED1']);
    assert.equal(Object.prototype.hasOwnProperty.call(defaultList.body.requests[0], 'verificationTokenHash'), false);

    const allList = await request(app)
      .get('/api/admin/dpdp/privacy-requests?status=all')
      .set('Cookie', 'np_admin=founder@example.com');
    assert.equal(allList.statusCode, 200);
    assert.deepEqual(allList.body.requests.map((item) => item.requestId), ['DPDP-20260703-VERIFIED1', 'DPDP-20260703-PENDING1']);
  });
});

test('PATCH /api/admin/dpdp/privacy-requests/:id updates allowed fields and audits status note changes', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-PATCH01',
        fullName: 'Patch User',
        email: 'patch@example.com',
        requestType: 'withdraw_consent',
        message: 'Please withdraw my consent.',
        source: 'Frontend Form',
        status: 'Verified',
        adminNote: null,
        handledBy: null,
        replySentAt: null,
        createdAt: '2026-07-03T12:00:00.000Z',
        updatedAt: '2026-07-03T12:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .patch('/api/admin/dpdp/privacy-requests/DPDP-20260703-PATCH01')
      .set('Cookie', 'np_admin=founder@example.com')
      .send({ status: 'In Review', adminNote: '<b>Review started</b>', handledBy: 'Founder' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.request.status, 'In Review');
    assert.equal(res.body.request.adminNote, 'Review started');
    assert.equal(res.body.request.handledBy, 'Founder');

    const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].requestId, 'DPDP-20260703-PATCH01');
    assert.equal(auditLogs[0].action, 'privacy_request_admin_updated');
    assert.equal(auditLogs[0].oldStatus, 'Verified');
    assert.equal(auditLogs[0].newStatus, 'In Review');
    assert.equal(auditLogs[0].adminNote, 'Review started');
    assert.equal(auditLogs[0].handledBy, 'Founder');
  });
});
