const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const CommunitySubmission = require('../models/CommunitySubmission');

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function matchesClause(doc, clause) {
  if (!clause || typeof clause !== 'object') return true;

  if (Array.isArray(clause.$and)) {
    return clause.$and.every((entry) => matchesClause(doc, entry));
  }

  if (Array.isArray(clause.$or)) {
    return clause.$or.some((entry) => matchesClause(doc, entry));
  }

  return Object.entries(clause).every(([key, expected]) => {
    if (key === '$and' || key === '$or') return true;

    const actual = getPath(doc, key);
    if (expected instanceof RegExp) {
      return expected.test(String(actual || ''));
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        return expected.$in.includes(actual);
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        return actual !== expected.$ne;
      }
      return matchesClause(actual || {}, expected);
    }

    return actual === expected;
  });
}

// Seed in-memory submissions: one with sourceType community, one legacy without sourceType
const seeded = [
  {
    _id: { toString: () => 'sub-1' },
    headline: 'Community Headline',
    body: 'Story body A',
    category: 'local',
    location: 'Ahmedabad',
    status: 'PENDING_FOUNDER',
    sourceType: 'community',
    reporterVerificationLevel: 'community_default',
    reporterId: null,
    reporterName: 'Alice',
    reporterEmail: 'alice@example.com',
    riskScore: 12,
    flags: [],
    createdAt: new Date(Date.now() - 1000),
  },
  {
    _id: { toString: () => 'sub-2' },
    headline: 'Legacy Headline',
    body: 'Story body B',
    category: 'civic',
    location: 'Pune',
    status: 'under_review',
    // no sourceType field (legacy)
    reporterVerificationLevel: 'unverified',
    reporterId: null,
    reporterName: 'Bob',
    reporterEmail: 'bob@example.com',
    riskScore: 5,
    flags: [],
    createdAt: new Date(Date.now() - 500),
  },
  {
    _id: { toString: () => 'sub-y1' },
    headline: 'Youth Pulse Headline',
    body: 'Youth story body',
    category: 'campus-buzz',
    desk: 'youth-pulse',
    submissionType: 'youth-pulse',
    intakeSource: 'youth-pulse',
    track: 'campus-buzz',
    location: { city: 'Surat', state: 'Gujarat', country: 'India' },
    status: 'NEW',
    sourceType: 'community',
    reporterVerificationLevel: 'unverified',
    reporterId: null,
    reporterName: 'Yamini',
    reporterEmail: 'yamini@example.com',
    attachments: [{ url: 'https://example.com/youth-story.pdf', name: 'story.pdf' }],
    riskScore: 2,
    flags: [],
    createdAt: new Date(Date.now() - 250),
  },
];

CommunitySubmission.find = (filter) => {
  // Emulate minimal query builder chain
  const api = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() {
      let results = seeded.slice();
      if (filter) {
        results = results.filter((doc) => matchesClause(doc, filter));
      }
      return results;
    },
  };
  return api;
};
CommunitySubmission.countDocuments = async (filter) => {
  const items = await CommunitySubmission.find(filter).lean();
  return items.length;
};

// Test: pending submissions (source=community) should include both seeded docs
// because legacy missing sourceType counts as community.
test('Admin community submissions pending returns legacy + community docs', async () => {
  const res = await request(app)
    .get('/admin/community-reporter/submissions?source=community&status=pending')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  const ids = res.body.submissions.map(i => i.id).sort();
  assert.deepStrictEqual(ids, ['sub-1', 'sub-2', 'sub-y1']);
});

// Test: source=all should return both without sourceType restriction
test('Admin community submissions source=all returns both docs', async () => {
  const res = await request(app)
    .get('/admin/community-reporter/submissions?source=all&status=pending')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.submissions.length, 3);
});

test('Admin Youth Pulse desk route returns only youth pulse submissions with metadata', async () => {
  const res = await request(app)
    .get('/admin/community-reporter/youth-pulse?status=pending')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.submissions.length, 1);
  assert.strictEqual(res.body.submissions[0].id, 'sub-y1');
  assert.strictEqual(res.body.submissions[0].desk, 'youth-pulse');
  assert.strictEqual(res.body.submissions[0].track, 'campus-buzz');
  assert.strictEqual(res.body.submissions[0].attachments.length, 1);
});

// Validate rejected filter supports legacy + uppercase values
test('Admin community submissions status=rejected returns only rejected set', async () => {
  // include a rejected uppercase doc in seed during runtime by patching find
  const originalFind = CommunitySubmission.find;
  CommunitySubmission.find = (filter) => {
    const api = {
      sort() { return this; }, skip() { return this; }, limit() { return this; },
      async lean() {
        let results = seeded.slice();
        results.push({ _id: { toString: () => 'sub-3' }, headline: 'Rejected Upper', body: 'x', category: 'civic', location: 'Pune', status: 'REJECTED' });
        if (filter) {
          results = results.filter((doc) => matchesClause(doc, filter));
        }
        return results;
      },
    };
    return api;
  };
  const res = await request(app)
    .get('/admin/community-reporter/submissions?status=rejected')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  const ids = res.body.submissions.map(i => i.id).sort();
  assert.deepStrictEqual(ids, ['sub-3']);
  CommunitySubmission.find = originalFind;
});

// Detail route alias should return same shape for community-reporter path
test('GET /api/admin/community-reporter/submissions/:id returns submission detail', async () => {
  const originalFindById = CommunitySubmission.findById;
  const testId = '507f1f77bcf86cd799439011';
  CommunitySubmission.findById = (id) => {
    return {
      async lean() {
        if (id === testId) {
          return {
            _id: testId,
            name: 'Abhi',
            email: 'abhi@example.com',
            location: 'Delhi',
            category: 'local',
            headline: 'Road repair needed',
            status: 'PENDING_FOUNDER',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      },
    };
  };
  // supertest path
  const res = await request(app)
    .get(`/api/admin/community-reporter/submissions/${testId}`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.submission);
  assert.strictEqual(res.body.submission.headline, 'Road repair needed');
  CommunitySubmission.findById = originalFindById;
});

// Validate approved filter supports legacy + uppercase values
test('Admin community submissions status=approved returns approved variants', async () => {
  const originalFind = CommunitySubmission.find;
  CommunitySubmission.find = (filter) => {
    const api = {
      sort() { return this; }, skip() { return this; }, limit() { return this; },
      async lean() {
        let results = seeded.slice();
        // Inject approved variants
        results.push({ _id: { toString: () => 'sub-4' }, headline: 'Approved Lower', body: 'y', category: 'local', location: 'Delhi', status: 'approved' });
        results.push({ _id: { toString: () => 'sub-5' }, headline: 'Approved Upper', body: 'z', category: 'local', location: 'Mumbai', status: 'APPROVED' });
        if (filter) {
          results = results.filter((doc) => matchesClause(doc, filter));
        }
        return results;
      },
    };
    return api;
  };
  const res = await request(app)
    .get('/admin/community-reporter/submissions?status=approved')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  const ids = res.body.submissions.map(i => i.id).sort();
  assert.deepStrictEqual(ids, ['sub-4', 'sub-5']);
  CommunitySubmission.find = originalFind;
});

// Unknown status should fall back to direct equality (returns empty when none match)
test('Admin community submissions unknown status falls back to equality', async () => {
  const res = await request(app)
    .get('/admin/community-reporter/submissions?status=foobar')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.deepStrictEqual(res.body.submissions, []);
});

// Decision route approve
test('POST /api/admin/community-reporter/submissions/:id/decision approve sets APPROVED', async () => {
  const originalFindById = CommunitySubmission.findById;
  const testId = '507f1f77bcf86cd799439022';
  let savedStatus = null; let savedRejectReason = null;
  let savedDecisionBy = null; let savedDecisionAt = null;
  CommunitySubmission.findById = (id) => ({
    async lean() { return null; },
    async save() { savedStatus = this.status; savedRejectReason = this.rejectReason; savedDecisionBy = this.decisionBy; savedDecisionAt = this.decisionAt; },
    _id: testId,
    status: 'PENDING_FOUNDER',
    headline: 'Approve Me',
    category: 'local',
    location: 'Delhi',
    createdAt: new Date(),
    updatedAt: new Date(),
    decisionBy: null,
    decisionAt: null,
  });
  const res = await request(app)
    .post(`/api/admin/community-reporter/submissions/${testId}/decision`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ decision: 'approve' });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(savedStatus, 'APPROVED');
  assert.strictEqual(savedRejectReason, undefined);
  assert.ok(savedDecisionBy);
  assert.ok(savedDecisionAt instanceof Date || typeof savedDecisionAt === 'object');
  CommunitySubmission.findById = originalFindById;
});

// Decision route reject
test('POST /api/admin/community-reporter/submissions/:id/decision reject sets REJECTED + reason', async () => {
  const originalFindById = CommunitySubmission.findById;
  const testId = '507f1f77bcf86cd799439023';
  let savedStatus = null; let savedRejectReason = null;
  let savedDecisionBy = null; let savedDecisionAt = null;
  CommunitySubmission.findById = (id) => ({
    async lean() { return null; },
    async save() { savedStatus = this.status; savedRejectReason = this.rejectReason; savedDecisionBy = this.decisionBy; savedDecisionAt = this.decisionAt; },
    _id: testId,
    status: 'under_review',
    headline: 'Reject Me',
    category: 'local',
    location: 'Mumbai',
    createdAt: new Date(),
    updatedAt: new Date(),
    decisionBy: null,
    decisionAt: null,
  });
  const res = await request(app)
    .post(`/api/admin/community-reporter/submissions/${testId}/decision`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ decision: 'reject', rejectReason: 'Low quality' });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(savedStatus, 'REJECTED');
  assert.strictEqual(savedRejectReason, 'Low quality');
  assert.ok(savedDecisionBy);
  assert.ok(savedDecisionAt instanceof Date || typeof savedDecisionAt === 'object');
  CommunitySubmission.findById = originalFindById;
});

test('PATCH /api/admin/community-reporter/youth-pulse/submissions/:id/status updates workflow status', async () => {
  const originalFindById = CommunitySubmission.findById;
  const testId = '507f1f77bcf86cd799439025';
  let savedStatus = null;

  CommunitySubmission.findById = () => ({
    _id: testId,
    status: 'NEW',
    desk: 'youth-pulse',
    track: 'campus-buzz',
    linkedArticleId: '507f1f77bcf86cd799439999',
    async save() { savedStatus = this.status; },
  });

  const res = await request(app)
    .patch(`/api/admin/community-reporter/youth-pulse/submissions/${testId}/status`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ status: 'AI_REVIEWED' });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(savedStatus, 'AI_REVIEWED');
  CommunitySubmission.findById = originalFindById;
});

// Invalid decision returns 400
test('POST /api/admin/community-reporter/submissions/:id/decision invalid returns 400', async () => {
  const originalFindById = CommunitySubmission.findById;
  const testId = '507f1f77bcf86cd799439024';
  CommunitySubmission.findById = (id) => ({
    async lean() { return null; },
    async save() {},
    _id: testId,
    status: 'under_review',
    headline: 'Bad Decision',
    category: 'local',
    location: 'Kolkata',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const res = await request(app)
    .post(`/api/admin/community-reporter/submissions/${testId}/decision`)
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ decision: 'not-valid' });
  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body && res.body.message && /invalid decision/i.test(res.body.message));
  CommunitySubmission.findById = originalFindById;
});
