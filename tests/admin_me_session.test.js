process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-me-session-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const request = require('supertest');

const adminRoutes = require('../routes/admin');
const User = require('../models/User');

function buildApp() {
  const app = express();
  app.use('/api/admin', adminRoutes);
  return app;
}

function buildAdminApiApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin-api/admin', adminRoutes);
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

function envSnapshot(keys) {
  return keys.reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {});
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function cookieAttr(cookie, name) {
  return (String(cookie || '').match(new RegExp(`${name}=([^;]+)`, 'i')) || [])[1] || null;
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

test('GET /admin-api/admin/me rejects an expired session token', async () => {
  const token = jwt.sign({
    sub: '507f1f77bcf86cd799439036',
    email: 'expired-token@example.com',
    name: 'Expired Token',
    role: 'editor',
    tokenVersion: 0,
    type: 'access',
  }, process.env.JWT_SECRET, { expiresIn: '-1s' });

  const response = await request(buildAdminApiApp())
    .get('/admin-api/admin/me')
    .set('Cookie', `np_admin_token=${encodeURIComponent(token)}`);

  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
});

async function withDatabaseUser(user, run) {
  const readyState = mongoose.connection.readyState;
  const findById = User.findById;
  const findOne = User.findOne;
  const findByIdAndUpdate = User.findByIdAndUpdate;
  mongoose.connection.readyState = 1;
  User.findById = async (id) => (String(id) === String(user._id) ? user : null);
  User.findOne = async (query) => (query?.email && String(query.email).toLowerCase() === String(user.email).toLowerCase() ? user : null);
  User.findByIdAndUpdate = async () => user;
  try {
    await run();
  } finally {
    mongoose.connection.readyState = readyState;
    User.findById = findById;
    User.findOne = findOne;
    User.findByIdAndUpdate = findByIdAndUpdate;
  }
}

async function makeLoginUser(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439031',
    email: overrides.email || 'login-user@example.com',
    name: overrides.name || 'Login User',
    fullName: overrides.name || 'Login User',
    role: overrides.role || 'founder',
    status: overrides.status || 'active',
    accountStatus: overrides.accountStatus || overrides.status || 'active',
    tokenVersion: overrides.tokenVersion || 0,
    noExpiry: overrides.noExpiry !== false,
    accessExpiresAt: overrides.accessExpiresAt || null,
    passwordHash: await bcrypt.hash(overrides.password || 'Correct!123', 4),
    moduleAccessOverride: overrides.moduleAccessOverride || [],
    specialRightsOverride: overrides.specialRightsOverride || [],
    taskRightsOverride: overrides.taskRightsOverride || [],
    accountControlRightsOverride: overrides.accountControlRightsOverride || [],
    isFounder: overrides.role === 'founder' || overrides.isFounder === true,
    isProtected: overrides.role === 'founder' || overrides.isProtected === true,
    async save() { return this; },
    ...overrides,
  };
}

test('POST /admin-api/admin/login then GET /admin-api/admin/me restores a Founder session from cookie', async () => {
  const password = 'Correct!123';
  const user = await makeLoginUser({ email: 'login-founder@example.com', role: 'founder', password });

  await withDatabaseUser(user, async () => {
    const agent = request.agent(buildAdminApiApp());
    const login = await agent
      .post('/admin-api/admin/login')
      .send({ email: user.email, password })
      .set('Origin', 'https://admin.newspulse.co.in');

    assert.equal(login.status, 200);
    assert.equal(login.body.ok, true);
    assert.ok(login.body.token);
    const cookies = login.headers['set-cookie'] || [];
    assert.equal(cookies.some((cookie) => String(cookie).startsWith('np_admin_token=')), true);

    const me = await agent
      .get('/admin-api/admin/me')
      .set('Origin', 'https://admin.newspulse.co.in');

    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, user.email);
    assert.equal(me.body.user.role, 'founder');
    assertNoSecrets(me.body);
  });
});

test('POST /admin-api/admin/login then GET /admin-api/admin/me restores a staff session from cookie', async () => {
  const password = 'Correct!123';
  const user = await makeLoginUser({
    _id: '507f1f77bcf86cd799439032',
    email: 'login-staff@example.com',
    role: 'editor',
    password,
    isFounder: false,
    isProtected: false,
  });

  await withDatabaseUser(user, async () => {
    const agent = request.agent(buildAdminApiApp());
    const login = await agent
      .post('/admin-api/admin/login')
      .send({ email: user.email, password })
      .set('Origin', 'https://admin.newspulse.co.in');

    assert.equal(login.status, 200);
    assert.equal(login.body.ok, true);

    const me = await agent
      .get('/admin-api/admin/me')
      .set('Origin', 'https://admin.newspulse.co.in');

    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, user.email);
    assert.equal(me.body.user.role, 'editor');
    assertNoSecrets(me.body);
  });
});

test('GET /admin-api/admin/me rejects expired login sessions after a valid login flow', async () => {
  const password = 'Correct!123';
  const user = await makeLoginUser({
    _id: '507f1f77bcf86cd799439033',
    email: 'expired-login-staff@example.com',
    role: 'editor',
    password,
    status: 'expired',
    accountStatus: 'expired',
    noExpiry: false,
    accessExpiresAt: new Date(Date.now() - 1000),
  });

  await withDatabaseUser(user, async () => {
    const token = tokenFor('editor', { id: user._id, email: user.email });
    const me = await request(buildAdminApiApp())
      .get('/admin-api/admin/me')
      .set('Cookie', `np_admin_token=${encodeURIComponent(token)}`);

    assert.equal(me.status, 403);
    assert.equal(me.body.code, 'ACCOUNT_EXPIRED');
  });
});

test('POST /admin-api/admin/logout clears login session cookie so /me returns 401', async () => {
  const password = 'Correct!123';
  const user = await makeLoginUser({
    _id: '507f1f77bcf86cd799439034',
    email: 'logout-staff@example.com',
    role: 'editor',
    password,
    isFounder: false,
    isProtected: false,
  });

  await withDatabaseUser(user, async () => {
    const agent = request.agent(buildAdminApiApp());
    const login = await agent.post('/admin-api/admin/login').send({ email: user.email, password });
    assert.equal(login.status, 200);

    const beforeLogout = await agent.get('/admin-api/admin/me');
    assert.equal(beforeLogout.status, 200);

    const logout = await agent.post('/admin-api/admin/logout');
    assert.equal(logout.status, 200);

    const afterLogout = await agent.get('/admin-api/admin/me');
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.body.code, 'UNAUTHORIZED');
  });
});

test('POST /admin-api/admin/login sets production-safe cross-subdomain cookie attributes', async () => {
  const snap = envSnapshot(['RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL', 'ADMIN_COOKIE_DOMAIN']);
  process.env.RENDER = '1';
  delete process.env.RENDER_SERVICE_ID;
  delete process.env.RENDER_EXTERNAL_URL;
  delete process.env.ADMIN_COOKIE_DOMAIN;
  const password = 'Correct!123';
  const user = await makeLoginUser({
    _id: '507f1f77bcf86cd799439035',
    email: 'cookie-founder@example.com',
    role: 'founder',
    password,
  });

  try {
    await withDatabaseUser(user, async () => {
      const login = await request(buildAdminApiApp())
        .post('/admin-api/admin/login')
        .send({ email: user.email, password })
        .set('Host', 'admin.newspulse.co.in')
        .set('Origin', 'https://admin.newspulse.co.in');

      assert.equal(login.status, 200);
      const cookies = login.headers['set-cookie'] || [];
      const sessionCookie = cookies.find((cookie) => String(cookie).startsWith('np_admin_token='));
      assert.ok(sessionCookie);
      assert.equal(/HttpOnly/i.test(sessionCookie), true);
      assert.equal(/;\s*Secure/i.test(sessionCookie), true);
      assert.equal(cookieAttr(sessionCookie, 'SameSite'), 'None');
      assert.equal(cookieAttr(sessionCookie, 'Domain'), '.newspulse.co.in');
      assert.equal(cookieAttr(sessionCookie, 'Path'), '/');
    });
  } finally {
    restoreEnv(snap);
  }
});

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