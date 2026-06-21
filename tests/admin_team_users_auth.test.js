process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-users-test-secret';
process.env.FOUNDER_EMAIL = process.env.FOUNDER_EMAIL || 'founder@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../server');

function signAdminToken(payload) {
  return jwt.sign(
    {
      sub: payload.sub || '507f1f77bcf86cd799439011',
      email: payload.email || 'founder@example.com',
      name: payload.name || 'Founder',
      role: payload.role || 'founder',
      tokenVersion: 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

test('GET /admin-api/admin/team/users accepts valid admin cookie token for founder', async () => {
  const token = signAdminToken({ role: 'founder' });

  const res = await request(app)
    .get('/admin-api/admin/team/users')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.users));
});

test('GET /admin-api/admin/team/roles accepts valid admin cookie token for founder', async () => {
  const token = signAdminToken({ role: 'founder' });

  const res = await request(app)
    .get('/admin-api/admin/team/roles')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.roles));
});

test('GET /api/admin/team/users still rejects missing token with JSON 401', async () => {
  const res = await request(app).get('/api/admin/team/users');

  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'UNAUTHORIZED');
  assert.equal(res.body.message, 'Unauthorized. Please login again.');
});

test('GET /api/admin/team/users still requires founder or team.manage', async () => {
  const token = signAdminToken({ role: 'admin', email: 'admin@example.com', name: 'Admin' });

  const res = await request(app)
    .get('/api/admin/team/users')
    .set('Cookie', `np_admin_token=${token}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'FORBIDDEN');
  assert.equal(res.body.message, 'Access denied. Founder permission required.');
});
