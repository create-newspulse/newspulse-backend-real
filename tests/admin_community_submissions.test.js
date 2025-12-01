const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const app = require('../server');
const CommunitySubmission = require('../models/CommunitySubmission');

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
];

CommunitySubmission.find = (filter) => {
  // Emulate minimal query builder chain
  const api = {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() {
      // Apply simple filtering by sourceType logic
      let results = seeded.slice();
      if (filter && filter.$or && !filter.sourceType) {
        // $or may include headline/location search; ignore for seed simplicity
        // If $or contains sourceType community conditions they will not appear here.
      }
      if (filter && filter.sourceType === 'journalist') {
        results = []; // none are journalist
      }
      if (filter && filter.$or && filter.$or.some(c => c.sourceType === 'community')) {
        // simulate community-specific filter: include those with sourceType community OR missing
        results = seeded.filter(s => s.sourceType === 'community' || s.sourceType === undefined);
      }
      if (filter && filter.status) {
        if (filter.status.$in) {
          results = results.filter(s => filter.status.$in.includes(s.status));
        } else if (typeof filter.status === 'string') {
          results = results.filter(s => s.status === filter.status);
        }
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
  assert.deepStrictEqual(ids, ['sub-1', 'sub-2']);
});

// Test: source=all should return both without sourceType restriction
test('Admin community submissions source=all returns both docs', async () => {
  const res = await request(app)
    .get('/admin/community-reporter/submissions?source=all&status=pending')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.strictEqual(res.body.submissions.length, 2);
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
        if (filter && filter.status) {
          if (filter.status.$in) {
            results = results.filter(s => filter.status.$in.includes(s.status));
          } else if (typeof filter.status === 'string') {
            results = results.filter(s => s.status === filter.status);
          }
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
        if (filter && filter.status) {
          if (filter.status.$in) {
            results = results.filter(s => filter.status.$in.includes(s.status));
          } else if (typeof filter.status === 'string') {
            results = results.filter(s => s.status === filter.status);
          }
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
