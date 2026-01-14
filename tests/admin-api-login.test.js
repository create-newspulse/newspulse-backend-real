const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
require('dotenv').config();

// Ensure JWT secret exists for token issuance during tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

function snapshotEnv(keys) {
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snapshot) {
  for (const [k, v] of Object.entries(snapshot)) {
    if (typeof v === 'undefined') delete process.env[k];
    else process.env[k] = v;
  }
}

test('POST /admin-api/admin/login returns 500 JSON when admin creds missing', async () => {
  const snap = snapshotEnv([
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'ADMIN_PASS',
    'FOUNDER_EMAIL',
    'FOUNDER_PASSWORD',
  ]);

  try {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASS;
    delete process.env.FOUNDER_EMAIL;
    delete process.env.FOUNDER_PASSWORD;

    const res = await request(app)
      .post('/admin-api/admin/login')
      .send({ email: 'x@example.com', password: 'x' })
      .set('Accept', 'application/json');

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { ok: false, message: 'Admin credentials not configured' });
  } finally {
    restoreEnv(snap);
  }
});

test('POST /admin-api/admin/login succeeds when ADMIN_* env vars exist', async () => {
  const snap = snapshotEnv([
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
  ]);

  try {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'pass123';

    const res = await request(app)
      .post('/admin-api/admin/login')
      .send({ email: 'admin@example.com', password: 'pass123' })
      .set('Accept', 'application/json');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.token, 'token should be present');
    assert.strictEqual(res.body.user.email, 'admin@example.com');
  } finally {
    restoreEnv(snap);
  }
});
