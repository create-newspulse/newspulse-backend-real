const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
test.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));

// Ensure founder env set for tests (fallback values)
process.env.FOUNDER_EMAIL = process.env.ADMIN_EMAIL = 'founder@example.invalid';
process.env.FOUNDER_PASSWORD = process.env.ADMIN_PASSWORD = require('node:crypto').randomBytes(24).toString('hex');
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');

const app = require('../server');
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
let account;
let previousState;
test.before(async () => {
  previousState = mongoose.connection.readyState;
  account = {
    _id: '507f1f77bcf86cd799439011', email: process.env.FOUNDER_EMAIL, role: 'founder',
    status: 'active', accountStatus: 'active', tokenVersion: 0,
    passwordHash: await require('bcrypt').hash(process.env.FOUNDER_PASSWORD, 4),
    save: async function () { return this; },
  };
  mongoose.connection.readyState = 1;
  const query = () => ({ select: async () => account, lean: async () => account, then: resolve => Promise.resolve(account).then(resolve) });
  test.mock.method(User, 'findOne', query);
  test.mock.method(User, 'findById', query);
  test.mock.method(User, 'findOneAndUpdate', async filter => {
    const version = typeof filter.tokenVersion === 'object' ? 0 : filter.tokenVersion;
    if (version !== account.tokenVersion) return null;
    account.tokenVersion += 1;
    return account;
  });
  test.mock.method(AuditLog, 'create', async () => ({}));
});
test.after(() => { mongoose.connection.readyState = previousState; });

let accessToken = null;
let refreshToken = null;

function postLogin() {
  return request(app)
    .post('/admin/login')
    .send({ email: process.env.FOUNDER_EMAIL, password: process.env.FOUNDER_PASSWORD })
    .set('Accept', 'application/json');
}

test('Login success returns tokens and user', async () => {
  const res = await postLogin();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success, 'success flag true');
  assert.ok(res.body.accessToken, 'has accessToken');
  assert.ok(res.body.refreshToken, 'has refreshToken');
  assert.ok(res.body.user.email === process.env.FOUNDER_EMAIL);
  accessToken = res.body.accessToken;
  refreshToken = res.body.refreshToken;
});

test('Session with valid access token', async () => {
  const res = await request(app)
    .get('/admin-auth/session')
    .set('Authorization', `Bearer ${accessToken}`);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success, 'session success');
  assert.ok(res.body.user);
});

test('Session with invalid token', async () => {
  const res = await request(app)
    .get('/admin-auth/session')
    .set('Authorization', 'Bearer invalidtoken');
  assert.strictEqual(res.statusCode, 200); // returns success false
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.user, null);
});

test('Refresh returns new access token', async () => {
  const res = await request(app)
    .post('/admin/refresh')
    .send({ refreshToken })
    .set('Accept', 'application/json');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success, 'refresh success');
  assert.ok(res.body.accessToken, 'new access token received');
});

test('Metrics endpoint returns structure', async () => {
  const res = await request(app).get('/admin/metrics');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.ok(typeof res.body.uptimeSeconds === 'number');
  assert.ok(res.body.rateLimit);
  assert.ok(res.body.tokens);
});

test('Invalid refresh token fails', async () => {
  const res = await request(app)
    .post('/admin/refresh')
    .send({ refreshToken: 'badtoken' })
    .set('Accept', 'application/json');
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.success, false);
});

test('admin compatibility login aliases use persisted account credentials', async () => {
  for (const route of ['/api/admin/login', '/admin-api/admin/login', '/admin-api/api/admin/login']) {
    const response = await request(app).post(route).send({ email: account.email, password: process.env.FOUNDER_PASSWORD });
    assert.strictEqual(response.status, 200, route);
    assert.strictEqual(response.body.user.role, 'founder');
    assert.strictEqual(require('jsonwebtoken').decode(response.body.refreshToken).type, 'refresh');
  }
});
