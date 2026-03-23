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
        populate() {
          return this;
        },
        lean() {
          return Promise.resolve([
            {
              _id: '69bfaf0033f48cb984646ef0',
              headline: 'ગુજરાતી સમાચાર',
              status: 'NEW',
              reporterName: 'Ravi Reporter',
              reporterEmail: 'ravi@example.com',
              category: null,
              aiSuggestedCategory: 'Local',
              locationDetail: { city: 'Rajkot', district: 'Rajkot', state: 'Gujarat' },
              createdAt: '2026-03-22T08:57:36.061Z',
              updatedAt: '2026-03-22T08:58:52.332Z',
            },
          ]);
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
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.page, 1);

    assert.equal(calls.find.length, 1);
    const filter = calls.find[0];

    // The handler uses $regex: escaped string, $options: 'i'
    assert.deepEqual(filter.headline, { $regex: '\\(', $options: 'i' });

    const row = res.body.items[0];
    assert.equal(row.reporterName, 'Ravi Reporter');
    assert.equal(row.reporterEmail, 'ravi@example.com');
    assert.equal(row.category, 'Local');
    assert.equal(row.language, 'gu');
    assert.equal(row.city, 'Rajkot');
    assert.equal(row.district, 'Rajkot');
    assert.equal(row.state, 'Gujarat');
    assert.equal(row.publicationStatus, 'pending');
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});
