const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
require('dotenv').config();

// Ensure founder env set for tests (fallback values)
process.env.FOUNDER_EMAIL = process.env.FOUNDER_EMAIL || 'founder@example.com';
process.env.FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD || 'local-test-credential';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

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
