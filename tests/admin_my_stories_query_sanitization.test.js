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
              locationDetail: { city: 'Rajkot', district: 'Rajkot', state: 'Gujarat', country: 'India' },
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
    assert.equal(row.category, 'local');
    assert.equal(row.language, 'gu');
    assert.equal(row.city, 'Rajkot');
    assert.equal(row.district, 'Rajkot');
    assert.equal(row.state, 'Gujarat');
    assert.equal(row.country, 'India');
    assert.equal(row.publicationStatus, 'not_published');
    // Optional fields are present and must be stable (can be null).
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'publicUrl'));
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'adminNewsApiUrl'));
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'adminArticleApiUrl'));

    assert.equal(row.affectsLiveSite, false);

    assert.equal(row.canSoftDelete, true);
    assert.equal(row.canArchive, true);
    assert.equal(row.canRestore, false);
    assert.equal(row.canPermanentDelete, false);
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});

test('Admin my-stories: computes isPublished from linked News/Article and normalizes category', async () => {
  const token = jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const originalFind = CommunitySubmission.find;
  const originalCount = CommunitySubmission.countDocuments;

  try {
    CommunitySubmission.find = () => {
      return {
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean() {
          return Promise.resolve([
            // Approved but NOT published (no linked article)
            {
              _id: '000000000000000000000001',
              headline: 'Draft community story',
              status: 'APPROVED',
              reporterName: 'Alice',
              reporterEmail: 'alice@example.com',
              category: 'Business',
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
            // Published via linked News doc
            {
              _id: '000000000000000000000002',
              headline: 'Gujarati headline \u0A97\u0AC1\u0A9C\u0AB0\u0ABE\u0AA4\u0AC0',
              status: 'APPROVED',
              reporterName: 'Bob',
              reporterEmail: 'bob@example.com',
              linkedArticleId: {
                _id: '111111111111111111111111',
                status: 'published',
                publishedAt: new Date(Date.now() - 60_000),
                category: 'International',
                slug: 'live-news-slug',
                slugs: { gu: 'gu-live-news-slug' },
                lang: 'en',
              },
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
          ]);
        },
      };
    };

    CommunitySubmission.countDocuments = () => Promise.resolve(2);

    const res = await request(app)
      .get('/admin-api/admin/community/my-stories')
      .set('Authorization', `Bearer ${token}`)
      .query({ page: 1, limit: 50 });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.items.length, 2);

    const a = res.body.items[0];
    assert.equal(a.reporterName, 'Alice');
    assert.equal(a.category, 'business');
    assert.equal(a.isPublished, false);
    assert.equal(a.publicationStatus, 'not_published');

    const b = res.body.items[1];
    assert.equal(b.reporterName, 'Bob');
    assert.equal(b.category, 'international');
    assert.equal(b.isPublished, true);
    assert.equal(b.publicationStatus, 'published');
    // Gujarati script should not be mislabeled as EN.
    assert.equal(b.language, 'gu');
    assert.equal(b.linkedArticleId, '111111111111111111111111');
    assert.equal(b.sourceId, '111111111111111111111111');
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});

test('Admin my-stories: deleted-state capability flags work for legacy status=DELETED without isDeleted', async () => {
  const token = jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const originalFind = CommunitySubmission.find;
  const originalCount = CommunitySubmission.countDocuments;

  try {
    CommunitySubmission.find = () => {
      return {
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean() {
          return Promise.resolve([
            {
              _id: '000000000000000000000099',
              headline: 'Legacy deleted row',
              status: 'DELETED',
              // Note: isDeleted intentionally omitted
              reporterName: 'Alice',
              reporterEmail: 'alice@example.com',
              category: 'Business',
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
          ]);
        },
      };
    };

    CommunitySubmission.countDocuments = () => Promise.resolve(1);

    const res = await request(app)
      .get('/admin-api/admin/community/my-stories')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 1);

    const row = res.body.items[0];
    assert.equal(row.isDeleted, true);
    assert.equal(row.canSoftDelete, false);
    assert.equal(row.canRestore, true);
    // No linked published record, so permanent delete is allowed for admin.
    assert.equal(row.canPermanentDelete, true);
    assert.equal(row.affectsLiveSite, false);

    // Linked status fields are always present (can be null).
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'linkedArticleStatus'));
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'linkedNewsStatus'));
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'linkedPublicArticleStatus'));
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});

test('Admin my-stories: infers category from headline when explicit category is missing', async () => {
    const token = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );

    const originalFind = CommunitySubmission.find;
    const originalCount = CommunitySubmission.countDocuments;

    try {
      CommunitySubmission.find = () => {
        return {
          sort() { return this; },
          skip() { return this; },
          limit() { return this; },
          populate() { return this; },
          lean() {
            return Promise.resolve([
              {
                _id: '000000000000000000000010',
                headline: 'Gold and silver prices crash today',
                body: 'Market update: gold, silver, and rupee movement...',
                status: 'APPROVED',
                reporterName: 'Ravi',
                reporterEmail: 'ravi@example.com',
                category: null,
                createdAt: '2026-03-22T00:00:00.000Z',
                updatedAt: '2026-03-22T00:00:00.000Z',
              },
              {
                _id: '000000000000000000000011',
                headline: 'Middle East war update: Iran and Israel tensions',
                body: 'International update with war keywords but also oil price mention...',
                status: 'APPROVED',
                reporterName: 'Meera',
                reporterEmail: 'meera@example.com',
                category: null,
                createdAt: '2026-03-22T00:00:00.000Z',
                updatedAt: '2026-03-22T00:00:00.000Z',
              },
              {
                _id: '000000000000000000000012',
                headline: 'Gujarat weather update',
                body: 'Regional story',
                status: 'APPROVED',
                reporterName: 'Kishan',
                reporterEmail: 'kishan@example.com',
                category: null,
                locationDetail: { state: 'Gujarat' },
                createdAt: '2026-03-22T00:00:00.000Z',
                updatedAt: '2026-03-22T00:00:00.000Z',
              },
            ]);
          },
        };
      };

      CommunitySubmission.countDocuments = () => Promise.resolve(3);

      const res = await request(app)
        .get('/admin-api/admin/community/my-stories')
        .set('Authorization', `Bearer ${token}`)
        .query({ page: 1, limit: 50 });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.total, 3);

      const [a, b, c] = res.body.items;
      assert.equal(a.category, 'business');
      assert.equal(b.category, 'international');
      assert.equal(c.category, 'regional');
    } finally {
      CommunitySubmission.find = originalFind;
      CommunitySubmission.countDocuments = originalCount;
    }

});

test('Admin my-stories: uses resolved public copy (__publicCopy) for published state and articleId', async () => {
  const token = jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const originalFind = CommunitySubmission.find;
  const originalCount = CommunitySubmission.countDocuments;

  try {
    CommunitySubmission.find = () => {
      return {
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean() {
          return Promise.resolve([
            {
              _id: '000000000000000000000003',
              headline: 'ગુજરાતી headline',
              status: 'APPROVED',
              reporterName: 'Chirag',
              reporterEmail: 'chirag@example.com',
              linkedArticleId: {
                _id: '111111111111111111111112',
                // Not publicly visible via News fields
                status: 'draft',
                publishedAt: null,
                slug: 'draft-news-slug',
              },
              // Simulate handler-attached resolved public copy (Article)
              __publicCopy: {
                _id: '222222222222222222222222',
                sourceNewsId: '111111111111111111111112',
                status: 'published',
                publishedAt: new Date(Date.now() - 60_000),
                slug: 'public-article-slug',
                slugs: { gu: 'gu-public-article-slug' },
              },
              createdAt: '2026-03-22T00:00:00.000Z',
              updatedAt: '2026-03-22T00:00:00.000Z',
            },
          ]);
        },
      };
    };

    CommunitySubmission.countDocuments = () => Promise.resolve(1);

    const res = await request(app)
      .get('/admin-api/admin/community/my-stories')
      .set('Authorization', `Bearer ${token}`)
      .query({ page: 1, limit: 50 });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items.length, 1);

    const row = res.body.items[0];
    assert.equal(row.isPublished, true);
    assert.equal(row.publicationStatus, 'published');
    // Prefer public Article copy id when available.
    assert.equal(row.articleId, '222222222222222222222222');
    assert.equal(row.adminArticleApiUrl, '/api/admin/articles/222222222222222222222222');
    // sourceId should still prefer linked News id.
    assert.equal(row.sourceId, '111111111111111111111112');
  } finally {
    CommunitySubmission.find = originalFind;
    CommunitySubmission.countDocuments = originalCount;
  }
});
