process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-me-session-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const adminRoutes = require('../routes/admin');
const User = require('../models/User');

function buildApp() {
  const app = express();
  app.use('/api/admin', adminRoutes);
  return app;
}

function tokenFor(role, overrides = {}) {
  return jwt.sign({
    sub: overrides.id || '507f1f77bcf86cd799439011',
    email: overrides.email || `${role}@example.com`,
    name: 'Session User',
    role,
    tokenVersion: 0,
    type: 'access',
  }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function assertNoSecrets(body) {
  const text = JSON.stringify(body);
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes('passwordHash'), false);
  assert.equal(text.includes('token'), false);
}

test('GET /api/admin/me returns canonical safe session data for a founder', async () => {
  const response = await request(buildApp())
    .get('/api/admin/me')
    .set('Authorization', `Bearer ${tokenFor('founder')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'founder');
  assert.equal(response.body.user.isFounder, true);
  assert.equal(response.body.admin.role, 'founder');
  assertNoSecrets(response.body);
});

test('GET /api/admin/me accepts an active staff session with no optional access fields', async () => {
  const response = await request(buildApp())
    .get('/api/admin/me')
    .set('Authorization', `Bearer ${tokenFor('editor')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'editor');
  assert.equal(response.body.user.noExpiry, true);
  assert.equal(response.body.user.staffId, null);
  assertNoSecrets(response.body);
});

test('GET /api/admin/me accepts the JWT from the admin session cookie', async () => {
  const token = tokenFor('editor');
  const response = await request(buildApp())
    .get('/api/admin/me')
    .set('Cookie', `np_admin_token=${encodeURIComponent(token)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'editor');
  assert.equal(response.body.authenticated, true);
  assertNoSecrets(response.body);
});

test('GET /api/admin/me preserves a valid legacy staff role during session hydration', async () => {
  const response = await request(buildApp())
    .get('/api/admin/me')
    .set('Authorization', `Bearer ${tokenFor('owner')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'owner');
});

test('GET /api/admin/me rejects an unauthenticated request', async () => {
  const response = await request(buildApp()).get('/api/admin/me');

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
});

test('GET /api/admin/me rejects malformed sessions with the existing auth contract', async () => {
  for (const requestBuilder of [
    () => request(buildApp()).get('/api/admin/me').set('Authorization', 'Bearer not-a-jwt'),
    () => request(buildApp()).get('/api/admin/me').set('Cookie', 'np_admin_token=np.not-a-jwt'),
  ]) {
    const response = await requestBuilder();
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'UNAUTHORIZED');
  }
});

async function withDatabaseUser(user, run) {
  const readyState = mongoose.connection.readyState;
  const findById = User.findById;
  const findByIdAndUpdate = User.findByIdAndUpdate;
  mongoose.connection.readyState = 1;
  User.findById = async () => user;
  User.findByIdAndUpdate = async () => user;
  try {
    await run();
  } finally {
    mongoose.connection.readyState = readyState;
    User.findById = findById;
    User.findByIdAndUpdate = findByIdAndUpdate;
  }
}

test('GET /api/admin/me accepts a legacy active staff record with no expiry or permission fields', async () => {
  const user = {
    _id: '507f1f77bcf86cd799439021',
    email: 'legacy-staff@example.com',
    name: 'Legacy Staff',
    role: 'editor',
    status: 'active',
    accountStatus: 'active',
    tokenVersion: 0,
  };

  await withDatabaseUser(user, async () => {
    const response = await request(buildApp())
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${tokenFor('editor', { id: user._id, email: user.email })}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, user.email);
    assert.equal(response.body.user.noExpiry, true);
    assertNoSecrets(response.body);
  });
});

test('GET /api/admin/me retains lifecycle rejections for suspended and expired staff', async () => {
  const baseUser = {
    _id: '507f1f77bcf86cd799439022',
    email: 'lifecycle-staff@example.com',
    name: 'Lifecycle Staff',
    role: 'editor',
    tokenVersion: 0,
  };

  for (const [status, expectedCode] of [['suspended', 'ACCOUNT_SUSPENDED'], ['expired', 'ACCOUNT_EXPIRED']]) {
    await withDatabaseUser({ ...baseUser, status, accountStatus: status }, async () => {
      const response = await request(buildApp())
        .get('/api/admin/me')
        .set('Authorization', `Bearer ${tokenFor('editor', { id: baseUser._id, email: baseUser.email })}`);

      assert.equal(response.status, 403);
      assert.equal(response.body.code, expectedCode);
    });
  }
});