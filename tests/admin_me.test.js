const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
const jwt = require('jsonwebtoken');

const app = require('../server');

test('GET /api/admin/me returns 401 JSON when unauthenticated', async () => {
  const res = await request(app).get('/api/admin/me');
  assert.equal(res.status, 401);
  assert.match(String(res.headers['content-type'] || ''), /^application\/json/i);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Unauthorized');
});

test('GET /admin-api/admin/me returns 401 JSON when unauthenticated', async () => {
  const res = await request(app).get('/admin-api/admin/me');
  assert.equal(res.status, 401);
  assert.match(String(res.headers['content-type'] || ''), /^application\/json/i);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Unauthorized');
});

test('GET /api/admin/me returns 200 when Bearer token is valid', async () => {
  const token = jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role: 'admin', tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const res = await request(app)
    .get('/api/admin/me')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.authenticated, true);
  assert.ok(res.body.admin);
});
