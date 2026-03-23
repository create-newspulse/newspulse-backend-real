const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
const jwt = require('jsonwebtoken');

const app = require('../server');
const CommunitySubmission = require('../models/CommunitySubmission');

test('Admin my-stories: escapes regex metacharacters in search and supports /admin-api alias', async () => {
  const token = jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const calls = { find: [], count: [] };

  const originalFind = CommunitySubmission.find;
  const originalCount = CommunitySubmission.countDocuments;

  try {
    // Create a chainable stub for find().sort().skip().limit().lean()
    CommunitySubmission.find = (filter) => {
      calls.find.push(filter);
      return {
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit() {
          return this;
        },
        lean() {
          return Promise.resolve([]);
        },
      };
    };

    CommunitySubmission.countDocuments = (filter) => {
      calls.count.push(filter);
      return Promise.resolve(0);
    };

    const res = await request(app)
      .get('/admin-api/admin/community/my-stories')
      .set('Authorization', `Bearer ${token}`)
      .query({ search: '(' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.page, 1);

    assert.equal(calls.find.length, 1);
    const filter = calls.find[0];

    // The handler uses $regex: escaped string, $options: 'i'
    assert.deepEqual(filter.headline, { $regex: '\\(', $options: 'i' });
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});
