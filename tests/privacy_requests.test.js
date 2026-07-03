const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const mongoose = require('mongoose');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const AdInquiry = require('../models/AdInquiry');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const News = require('../models/News');
const ReporterProfile = require('../models/ReporterProfile');
const ReporterContact = require('../models/ReporterContact');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const User = require('../models/User');
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

function makeObjectId(seed) {
  return String(seed || '1').padStart(24, '0').slice(-24);
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

function withMongoSourceStubs(stubs, fn) {
  const restoreEntries = [];
  for (const entry of stubs || []) {
    const target = entry && entry.target;
    const methods = entry && entry.methods;
    if (!target || !methods) continue;
    for (const [methodName, replacement] of Object.entries(methods)) {
      restoreEntries.push([target, methodName, target[methodName]]);
      target[methodName] = replacement;
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [target, methodName, original] of restoreEntries.reverse()) {
        target[methodName] = original;
      }
    });
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

test('POST /api/admin/dpdp/privacy-requests/:id/resend-verification refreshes token, extends expiry, and audits resend', async () => {
  await withRestoredDpdpFiles(async () => {
    const originalLog = console.log;
    const logLines = [];
    console.log = (...args) => {
      logLines.push(args.map((value) => String(value)).join(' '));
    };

    try {
      writeJson(PRIVACY_REQUESTS_FILE, [
        {
          requestId: 'DPDP-20260703-RESEND01',
          fullName: 'Resend User',
          email: 'resend@example.com',
          mobile: null,
          requestType: 'access',
          message: 'Please verify my request again.',
          source: 'Frontend Form',
          status: 'Pending Email Verification',
          verificationTokenHash: hashToken('old-token'),
          verificationTokenExpiresAt: '2026-07-03T00:00:00.000Z',
          verificationResendHistory: [],
          createdAt: '2026-07-03T10:00:00.000Z',
          updatedAt: '2026-07-03T10:00:00.000Z',
        },
      ]);

      const res = await request(app)
        .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-RESEND01/resend-verification')
        .set('Cookie', 'np_admin=founder@example.com');

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true, message: 'Verification email resent.' });

      const stored = JSON.parse(fs.readFileSync(PRIVACY_REQUESTS_FILE, 'utf8'));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].status, 'Pending Email Verification');
      assert.equal(typeof stored[0].verificationTokenHash, 'string');
      assert.notEqual(stored[0].verificationTokenHash, hashToken('old-token'));
      assert.ok(new Date(stored[0].verificationTokenExpiresAt).getTime() > Date.now());
      assert.equal(Array.isArray(stored[0].verificationResendHistory), true);
      assert.equal(stored[0].verificationResendHistory.length, 1);

      const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].requestId, 'DPDP-20260703-RESEND01');
      assert.equal(auditLogs[0].action, 'resend_verification');
      assert.equal(auditLogs[0].handledBy, 'founder@example.com');
      assert.equal(logLines.some((line) => line.includes('/api/privacy/verify/')), false);
    } finally {
      console.log = originalLog;
    }
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/resend-verification returns safe message for verified requests', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-RESEND02',
        fullName: 'Verified User',
        email: 'verified@example.com',
        mobile: null,
        requestType: 'access',
        message: 'Already verified request.',
        source: 'Frontend Form',
        status: 'Verified',
        verificationTokenHash: hashToken('existing-token'),
        verificationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationResendHistory: [],
        createdAt: '2026-07-03T11:00:00.000Z',
        updatedAt: '2026-07-03T11:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-RESEND02/resend-verification')
      .set('Cookie', 'np_admin=founder@example.com');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      ok: true,
      success: true,
      message: 'Verification email is not required for this request status.',
    });

    const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
    assert.equal(auditLogs.length, 0);
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/resend-verification enforces per-request daily resend limit', async () => {
  await withRestoredDpdpFiles(async () => {
    const now = Date.now();
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-RESEND03',
        fullName: 'Rate Limit User',
        email: 'limit@example.com',
        mobile: null,
        requestType: 'access',
        message: 'Rate limited request.',
        source: 'Frontend Form',
        status: 'Pending Email Verification',
        verificationTokenHash: hashToken('existing-token'),
        verificationTokenExpiresAt: new Date(now + 60_000).toISOString(),
        verificationResendHistory: [
          new Date(now - 1_000).toISOString(),
          new Date(now - 2_000).toISOString(),
          new Date(now - 3_000).toISOString(),
        ],
        createdAt: '2026-07-03T11:00:00.000Z',
        updatedAt: '2026-07-03T11:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-RESEND03/resend-verification')
      .set('Cookie', 'np_admin=founder@example.com');

    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, {
      ok: false,
      success: false,
      message: 'Verification email resend limit reached for this request. Please try again later.',
    });

    const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
    assert.equal(auditLogs.length, 0);
  });
});

test('GET /api/admin/dpdp/privacy-requests/:id/matching-data returns exact-match sources with safe previews only', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-MATCH01',
        fullName: 'Match User',
        email: 'match.user@example.com',
        mobile: '+919876543210',
        requestType: 'deletion',
        message: 'Please delete my public form data.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T12:00:00.000Z',
        updatedAt: '2026-07-03T12:00:00.000Z',
      },
    ]);

    await withMongoSourceStubs([
      {
        target: AdInquiry,
        methods: {
        find: async () => ([
          {
            _id: makeObjectId('101'),
            email: 'match.user@example.com',
            phone: '+919876543210',
          },
        ]),
      },
      },
      {
        target: CommunitySubmission,
        methods: {
        find: async () => ([
          {
            _id: makeObjectId('201'),
            reporterEmail: 'match.user@example.com',
            reporterEmailNorm: 'match.user@example.com',
            sourceType: 'community',
            phone: '+919876543210',
          },
        ]),
      },
      },
      {
        target: CommunityReport,
        methods: {
        find: async () => ([]),
      },
      },
      {
        target: ReporterContact,
        methods: {
        find: async () => ([
          {
            _id: makeObjectId('301'),
            reporterType: 'journalist',
            email: 'match.user@example.com',
            phoneFull: '+919876543210',
          },
        ]),
      },
      },
      {
        target: User,
        methods: {
        find: async () => ([
          {
            _id: makeObjectId('401'),
            email: 'match.user@example.com',
            role: 'reader',
            isProtected: false,
            isFounder: false,
          },
        ]),
      },
      },
    ], async () => {
      const res = await request(app)
        .get('/api/admin/dpdp/privacy-requests/DPDP-20260703-MATCH01/matching-data')
        .set('Cookie', 'np_admin=founder@example.com');

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.requestId, 'DPDP-20260703-MATCH01');
      assert.deepEqual(res.body.matchedBy.sort(), ['email', 'mobile']);
      assert.deepEqual(res.body.sources.map((item) => item.source), [
        'advertise_business_inquiries',
        'community_reporter_requests',
        'journalist_desk_requests',
        'user_accounts',
      ]);
      assert.equal(res.body.sources[0].records[0].preview, 'Business inquiry from ma***@example.com');
      assert.equal(res.body.sources[0].records[0].source, 'advertise_business_inquiries');
      assert.equal(res.body.sources[0].records[0].recordId, makeObjectId('101'));
      assert.equal(res.body.sources[0].records[0].deletable, true);
      assert.equal(res.body.sources[0].records[0].anonymizable, true);
      assert.equal(res.body.sources[1].records[0].recordId, makeObjectId('201'));
      assert.equal(res.body.sources[1].records[0].deletable, true);
      assert.equal(res.body.sources[2].records[0].recordId, makeObjectId('301'));
      assert.equal(res.body.sources[2].records[0].deletable, true);
      assert.equal(res.body.sources[3].records[0].recommendedAction, 'manual_review_required');
      assert.equal(res.body.sources[3].records[0].recordId, makeObjectId('401'));
      assert.equal(res.body.sources[3].records[0].deletable, false);
      assert.equal(res.body.sources[3].records[0].anonymizable, false);
      assert.equal(res.body.sources[3].records[0].blockedReason, 'Manual review only. This source cannot be deleted from DPDP quick action.');
      assert.equal(Object.prototype.hasOwnProperty.call(res.body.sources[0].records[0], 'email'), false);
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/data-action deletes only allowed source records and writes DPDP audit logs', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-ACTION01',
        fullName: 'Delete User',
        email: 'delete.user@example.com',
        mobile: '+919900000001',
        requestType: 'deletion',
        message: 'Delete my business inquiry.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T12:30:00.000Z',
        updatedAt: '2026-07-03T12:30:00.000Z',
      },
    ]);

    const deletedFilters = [];
    const deleteRecordId = makeObjectId('501');
    await withMongoSourceStubs([
      {
        target: AdInquiry,
        methods: {
        findById: async (id) => (id === deleteRecordId
          ? { _id: id, email: 'delete.user@example.com', phone: '+919900000001' }
          : null),
        deleteOne: async (filter) => {
          deletedFilters.push(filter);
          return { acknowledged: true, deletedCount: 1 };
        },
      },
      },
    ], async () => {
      const res = await request(app)
        .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-ACTION01/data-action')
        .set('Cookie', 'np_admin=founder@example.com')
        .send({
          action: 'delete',
          items: [{ source: 'advertise_business_inquiries', recordId: deleteRecordId }],
          adminNote: 'Verified business inquiry removed.',
          founderConfirmation: 'DELETE',
        });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.action, 'delete');
      assert.equal(res.body.processedCount, 1);
      assert.equal(res.body.request.status, 'In Review');
      assert.deepEqual(deletedFilters, [{ _id: deleteRecordId }]);

      const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].requestId, 'DPDP-20260703-ACTION01');
      assert.equal(auditLogs[0].action, 'privacy_data_delete');
      assert.equal(auditLogs[0].source, 'advertise_business_inquiries');
      assert.equal(auditLogs[0].recordId, deleteRecordId);
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/data-action rejects invalid record IDs safely', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-ACTIONBAD1',
        fullName: 'Invalid Record User',
        email: 'invalid.record@example.com',
        mobile: '+919900000004',
        requestType: 'deletion',
        message: 'Delete my selected record.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T12:30:00.000Z',
        updatedAt: '2026-07-03T12:30:00.000Z',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-ACTIONBAD1/data-action')
      .set('Cookie', 'np_admin=founder@example.com')
      .send({
        action: 'delete',
        items: [{ source: 'advertise_business_inquiries', recordId: 'advertise_business_inquiries-0' }],
        adminNote: 'Invalid record id test.',
        founderConfirmation: 'DELETE',
      });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      ok: false,
      success: false,
      message: 'Invalid record ID for selected item.',
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/data-action deletes community reporter requests using real record IDs', async () => {
  await withRestoredDpdpFiles(async () => {
    const communityRecordId = makeObjectId('701');
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-ACTIONCOMM1',
        fullName: 'Community Delete User',
        email: 'community.delete@example.com',
        mobile: '+919900000005',
        requestType: 'deletion',
        message: 'Delete my community request.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T12:30:00.000Z',
        updatedAt: '2026-07-03T12:30:00.000Z',
      },
    ]);

    const storyLinkFilters = [];
    const submissionDeleteFilters = [];
    await withMongoSourceStubs([
      {
        target: CommunitySubmission,
        methods: {
          findById: async (id) => (id === communityRecordId
            ? {
                _id: id,
                reporterEmail: 'community.delete@example.com',
                reporterEmailNorm: 'community.delete@example.com',
                email: 'community.delete@example.com',
                phone: '+919900000005',
                sourceType: 'community',
                linkedArticleId: null,
              }
            : null),
          deleteOne: async (filter) => {
            submissionDeleteFilters.push(filter);
            return { acknowledged: true, deletedCount: 1 };
          },
        },
      },
      {
        target: ReporterStoryLink,
        methods: {
          deleteMany: async (filter) => {
            storyLinkFilters.push(filter);
            return { acknowledged: true, deletedCount: 0 };
          },
        },
      },
    ], async () => {
      const res = await request(app)
        .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-ACTIONCOMM1/data-action')
        .set('Cookie', 'np_admin=founder@example.com')
        .send({
          action: 'delete',
          items: [{ source: 'community_reporter_requests', recordId: communityRecordId }],
          adminNote: 'Community reporter request removed.',
          founderConfirmation: 'DELETE',
        });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(storyLinkFilters, [{ submissionId: communityRecordId }]);
      assert.deepEqual(submissionDeleteFilters, [{ _id: communityRecordId }]);
      const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
      assert.equal(auditLogs[0].source, 'community_reporter_requests');
      assert.equal(auditLogs[0].recordId, communityRecordId);
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/data-action deletes journalist desk requests after detaching dependencies', async () => {
  await withRestoredDpdpFiles(async () => {
    const contactRecordId = makeObjectId('801');
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-ACTIONJOUR1',
        fullName: 'Journalist Delete User',
        email: 'journalist.delete@example.com',
        mobile: null,
        requestType: 'deletion',
        message: 'Delete my journalist request.',
        source: 'Frontend Form',
        status: 'Verified',
        createdAt: '2026-07-03T12:30:00.000Z',
        updatedAt: '2026-07-03T12:30:00.000Z',
      },
    ]);

    const contactDeleteFilters = [];
    const submissionDetachCalls = [];
    const profileDetachCalls = [];
    await withMongoSourceStubs([
      {
        target: ReporterContact,
        methods: {
          findById: async (id) => (id === contactRecordId
            ? {
                _id: id,
                reporterType: 'journalist',
                email: 'journalist.delete@example.com',
              }
            : null),
          deleteOne: async (filter) => {
            contactDeleteFilters.push(filter);
            return { acknowledged: true, deletedCount: 1 };
          },
        },
      },
      {
        target: CommunitySubmission,
        methods: {
          updateMany: async (filter, update) => {
            submissionDetachCalls.push({ filter, update });
            return { acknowledged: true, modifiedCount: 0 };
          },
        },
      },
      {
        target: ReporterProfile,
        methods: {
          updateMany: async (filter, update) => {
            profileDetachCalls.push({ filter, update });
            return { acknowledged: true, modifiedCount: 0 };
          },
        },
      },
    ], async () => {
      const res = await request(app)
        .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-ACTIONJOUR1/data-action')
        .set('Cookie', 'np_admin=founder@example.com')
        .send({
          action: 'delete',
          items: [{ source: 'journalist_desk_requests', recordId: contactRecordId }],
          adminNote: 'Journalist desk request removed.',
          founderConfirmation: 'DELETE',
        });

      assert.equal(res.statusCode, 200);
      assert.equal(submissionDetachCalls.length, 2);
      assert.deepEqual(profileDetachCalls, [{ filter: { reporterContactId: contactRecordId }, update: { $set: { reporterContactId: null } } }]);
      assert.deepEqual(contactDeleteFilters, [{ _id: contactRecordId }]);
      const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
      assert.equal(auditLogs[0].source, 'journalist_desk_requests');
      assert.equal(auditLogs[0].recordId, contactRecordId);
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/data-action anonymizes public submission records without touching user accounts', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-ACTION02',
        fullName: 'Anon User',
        email: 'anon.user@example.com',
        mobile: '+919900000002',
        requestType: 'deletion',
        message: 'Anonymize my reporter request.',
        source: 'Frontend Form',
        status: 'In Review',
        createdAt: '2026-07-03T13:00:00.000Z',
        updatedAt: '2026-07-03T13:00:00.000Z',
      },
    ]);

    const updates = [];
    const anonymizeRecordId = makeObjectId('601');
    await withMongoSourceStubs([
      {
        target: CommunitySubmission,
        methods: {
        findById: async (id) => (id === anonymizeRecordId
          ? {
              _id: id,
              reporterEmail: 'anon.user@example.com',
              reporterEmailNorm: 'anon.user@example.com',
              email: 'anon.user@example.com',
              phone: '+919900000002',
              sourceType: 'community',
            }
          : null),
        updateOne: async (filter, update) => {
          updates.push({ filter, update });
          return { acknowledged: true, modifiedCount: 1 };
        },
      },
      },
    ], async () => {
      const res = await request(app)
        .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-ACTION02/data-action')
        .set('Cookie', 'np_admin=founder@example.com')
        .send({
          action: 'anonymize',
          items: [{ source: 'community_reporter_requests', recordId: anonymizeRecordId }],
          adminNote: 'Reporter request anonymized.',
          founderConfirmation: 'ANONYMIZE',
          status: 'Completed',
        });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.request.status, 'Completed');
      assert.equal(updates.length, 1);
      assert.deepEqual(updates[0].filter, { _id: anonymizeRecordId });
      assert.equal(updates[0].update.$set.fullName, 'Deleted User');
      assert.match(updates[0].update.$set.reporterEmail, new RegExp(`^deleted\\+community-reporter-requests-${anonymizeRecordId}@privacy\\.local$`));

      const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'privacy_data_anonymize');
      assert.equal(auditLogs[0].source, 'community_reporter_requests');
      assert.equal(auditLogs[0].recordId, anonymizeRecordId);
    });
  });
});

test('POST /api/admin/dpdp/privacy-requests/:id/complete marks request completed and writes audit log without deleting data', async () => {
  await withRestoredDpdpFiles(async () => {
    writeJson(PRIVACY_REQUESTS_FILE, [
      {
        requestId: 'DPDP-20260703-COMPLETE1',
        fullName: 'Complete User',
        email: 'complete@example.com',
        mobile: '+919900000003',
        requestType: 'access',
        message: 'Close my verified request.',
        source: 'Frontend Form',
        status: 'In Review',
        actionTakenSummary: 'delete 1 advertise_business_inquiries',
        createdAt: '2026-07-03T14:00:00.000Z',
        updatedAt: '2026-07-03T14:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/dpdp/privacy-requests/DPDP-20260703-COMPLETE1/complete')
      .set('Cookie', 'np_admin=founder@example.com')
      .send({ adminNote: 'Reply sent to requester.', replySent: true });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.request.status, 'Completed');
    assert.ok(res.body.request.replySentAt);
    assert.match(res.body.request.actionTakenSummary, /completion recorded; reply sent: yes/);

    const auditLogs = JSON.parse(fs.readFileSync(DPDP_AUDIT_LOGS_FILE, 'utf8'));
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].action, 'privacy_request_completed');
    assert.equal(auditLogs[0].oldStatus, 'In Review');
    assert.equal(auditLogs[0].newStatus, 'Completed');
  });
});
