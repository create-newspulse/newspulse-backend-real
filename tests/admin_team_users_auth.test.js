require('./helpers/publicNewsIsolation');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
process.env.FOUNDER_EMAIL = 'founder@example.invalid';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');
const User = require('../models/User');
const Role = require('../models/Role');
const { accountAuthFixture } = require('./helpers/accountAuthFixture');
const auth = accountAuthFixture();

test.beforeEach(context => {
  auth.install(context);
  context.mock.method(User, 'find', () => ({
    sort() { return this; },
    lean: async () => [{
      _id: '507f1f77bcf86cd799439012', name: 'Synthetic Staff', email: 'staff@example.invalid',
      role: 'editor', status: 'active', accountStatus: 'active',
      staffId: 'NP-2026-0003', staffIdLocked: true, staffIdGeneratedAt: new Date('2026-01-01T00:00:00.000Z'),
    }],
  }));
  context.mock.method(Role, 'find', () => ({
    sort() { return this; },
    lean: async () => [{
      _id: '507f1f77bcf86cd799439021', name: 'Synthetic Editor', slug: 'editor',
      moduleAccess: [], specialRights: [], taskRights: [],
    }],
  }));
  context.mock.method(Role, 'updateOne', async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 0 }));
});

test('GET /admin-api/admin/team/users accepts valid admin cookie token for founder', async () => {
  const token = auth.token('founder');

  const res = await request(app)
    .get('/admin-api/admin/team/users')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.users));
  assert.equal(res.body.users.length, 1);
  assert.equal(res.body.users[0].staffId, 'NP-2026-0003');
  assert.equal(User.findById.mock.callCount(), 1);
  assert.ok(User.find.mock.callCount() > 0);
});

test('GET /admin-api/admin/team/roles accepts valid admin cookie token for founder', async () => {
  const token = auth.token('founder');

  const res = await request(app)
    .get('/admin-api/admin/team/roles')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.roles));
  assert.equal(res.body.roles.length, 1);
  assert.equal(res.body.roles[0].slug, 'editor');
  assert.equal(User.findById.mock.callCount(), 1);
  assert.equal(Role.find.mock.callCount(), 1);
  assert.ok(Role.updateOne.mock.callCount() > 0);
});

test('GET /api/admin/team/users still rejects missing token with JSON 401', async () => {
  const res = await request(app).get('/api/admin/team/users');

  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized. Please login again.');
  assert.equal(User.findById.mock.callCount(), 0);
  assert.equal(User.find.mock.callCount(), 0);
});

test('GET /api/admin/team/users still requires founder or team.manage', async () => {
  for (const claims of [{}, { role: 'founder' }]) {
    const token = auth.token('admin', claims);

    const res = await request(app)
      .get('/api/admin/team/users')
      .set('Cookie', `np_admin_token=${token}`);

    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(res.body.message, 'Access denied. Founder permission required.');
  }
  assert.equal(User.findById.mock.callCount(), 2);
  assert.equal(User.find.mock.callCount(), 0);
});

test('a signed Founder cookie without a persisted account cannot list users', async () => {
  const missingUserId = '507f1f77bcf86cd799439099';
  const token = auth.token('founder', { sub: missingUserId });
  const res = await request(app)
    .get('/api/admin/team/users')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(User.findById.mock.callCount(), 1);
  assert.equal(String(User.findById.mock.calls[0].arguments[0]), missingUserId);
  assert.equal(User.find.mock.callCount(), 0);
});

test('a persisted non-Founder cannot list or initialize role templates using a Founder token claim', async () => {
  const token = auth.token('admin', { role: 'founder' });
  const res = await request(app)
    .get('/admin-api/admin/team/roles')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 403);
  assert.equal(User.findById.mock.callCount(), 1);
  assert.equal(Role.find.mock.callCount(), 0);
  assert.equal(Role.updateOne.mock.callCount(), 0);
});
