process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-auth-routes-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const request = require('supertest');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const authRoutes = require('../routes/auth.routes');

let originalReadyState;
let staffUser;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

function makeUser(overrides = {}) {
  const user = {
    _id: '507f1f77bcf86cd799439021',
    email: 'staff@example.com',
    name: 'Staff User',
    fullName: 'Staff User',
    role: 'reporter',
    permissions: [],
    status: 'active',
    mustChangePassword: true,
    mustResetPassword: true,
    forceReset: true,
    tempPasswordExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    tokenVersion: 0,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    async save() {
      staffUser = this;
      return this;
    },
    ...overrides,
  };
  return user;
}

test.beforeEach(async () => {
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  staffUser = makeUser({ passwordHash: await bcrypt.hash('TempPass123', 4) });

  User.findOne = (filter) => ({
    select: async () => {
      const email = String(filter && filter.email || '').toLowerCase();
      return email === staffUser.email ? staffUser : null;
    },
  });
  User.findById = async (id) => (String(id) === String(staffUser._id) ? staffUser : null);
  User.findByIdAndUpdate = async (id, update) => {
    if (String(id) !== String(staffUser._id)) return null;
    if (update && update.$set) Object.assign(staffUser, update.$set);
    if (update && update.$inc && typeof update.$inc.tokenVersion === 'number') {
      staffUser.tokenVersion += update.$inc.tokenVersion;
    }
    return staffUser;
  };
  AuditLog.create = async () => ({ ok: true });
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
});

test('POST /api/auth/login returns tokens and never returns passwordHash or passwords', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'staff@example.com', password: 'TempPass123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.accessToken, 'string');
  assert.equal(typeof res.body.refreshToken, 'string');
  assert.equal(res.body.user.mustChangePassword, true);

  const payload = JSON.stringify(res.body);
  assert.equal(payload.includes('passwordHash'), false);
  assert.equal(payload.includes('currentPassword'), false);
  assert.equal(payload.includes('TempPass123'), false);
});

test('POST /api/auth/change-password clears first-login reset and stores only a new hash', async () => {
  const app = buildApp();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'staff@example.com', password: 'TempPass123' });

  const res = await request(app)
    .post('/api/auth/change-password')
    .set('Authorization', `Bearer ${login.body.accessToken}`)
    .send({ currentPassword: 'TempPass123', newPassword: 'NewPass123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.mustChangePassword, false);
  assert.equal(staffUser.mustChangePassword, false);
  assert.equal(staffUser.forceReset, false);
  assert.equal(await bcrypt.compare('NewPass123', staffUser.passwordHash), true);

  const payload = JSON.stringify(res.body);
  assert.equal(payload.includes('passwordHash'), false);
  assert.equal(payload.includes('TempPass123'), false);
  assert.equal(payload.includes('NewPass123'), false);
});