process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-account-routes-secret';
process.env.PASSWORD_HASH_ROUNDS = '4';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const request = require('supertest');

const User = require('../models/User');
const SessionLog = require('../models/SessionLog');
const OtpToken = require('../models/OtpToken');
const AuditLog = require('../models/AuditLog');
const adminAccountRoutes = require('../routes/adminAccount.routes');

let originalReadyState;
let usersById;
let sessions;
let sessionUpdates;
let otpTokenUpdates;
let auditLogs;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin-api/admin', adminAccountRoutes);
  return app;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      userId: String(user._id),
      email: user.email,
      role: user.role,
      name: user.fullName || user.name,
      tokenVersion: user.tokenVersion || 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function cloneUser(user) {
  if (!user) return null;
  return {
    ...user,
    assignedSections: Array.isArray(user.assignedSections) ? [...user.assignedSections] : [],
    coverageAreas: Array.isArray(user.coverageAreas) ? [...user.coverageAreas] : [],
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    async save() {
      usersById.set(String(this._id), this);
      return this;
    },
  };
}

function findUser(id) {
  return usersById.get(String(id)) || null;
}

function makeSession(id, userId, status = 'active') {
  return {
    _id: id,
    userId,
    loginAt: new Date('2026-06-21T08:00:00.000Z'),
    lastSeenAt: new Date('2026-06-21T09:00:00.000Z'),
    logoutAt: null,
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    device: 'desktop',
    status,
    logoutReason: null,
  };
}

test.beforeEach(async () => {
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  auditLogs = [];
  sessionUpdates = [];
  otpTokenUpdates = [];

  const founder = {
    _id: '507f1f77bcf86cd799439101',
    email: 'founder@example.com',
    name: 'Founder',
    fullName: 'Founder User',
    role: 'founder',
    staffId: 'NP-FND-0001',
    passwordHash: await bcrypt.hash('FounderPass123', 4),
    status: 'active',
    accountStatus: 'active',
    onlineStatus: 'online',
    isFounder: true,
    isProtected: true,
    tokenVersion: 0,
    lastLoginAt: new Date('2026-06-20T10:00:00.000Z'),
    lastPasswordChangedAt: new Date('2026-06-01T10:00:00.000Z'),
    currentSessionId: '67f1f77bcf86cd799439201',
    permissions: [],
  };

  const admin = {
    _id: '507f1f77bcf86cd799439102',
    email: 'admin@example.com',
    name: 'Admin',
    fullName: 'Admin User',
    role: 'admin',
    staffId: 'NP-2026-0002',
    passwordHash: await bcrypt.hash('AdminPass123', 4),
    status: 'active',
    accountStatus: 'active',
    onlineStatus: 'idle',
    isFounder: false,
    isProtected: false,
    tokenVersion: 0,
    permissions: [],
    assignedSections: ['All Sections'],
    coverageAreas: ['All Gujarat'],
    department: 'Administration',
    designation: 'Admin',
    accessExpiresAt: new Date('2026-12-31T00:00:00.000Z'),
  };

  const staff = {
    _id: '507f1f77bcf86cd799439103',
    email: 'staff@example.com',
    name: 'Staff',
    fullName: 'Staff User',
    role: 'reporter',
    staffId: 'NP-2026-0003',
    passwordHash: await bcrypt.hash('StaffPass123', 4),
    status: 'active',
    accountStatus: 'active',
    onlineStatus: 'online',
    isFounder: false,
    isProtected: false,
    tokenVersion: 0,
    permissions: [],
    assignedSections: ['Gujarat'],
    coverageAreas: ['Ahmedabad'],
    department: 'Field Reporting / Newsroom',
    designation: 'Reporter',
    mustChangePassword: true,
    mustResetPassword: true,
    forceReset: true,
    currentSessionId: '67f1f77bcf86cd799439203',
  };

  usersById = new Map([
    [founder._id, founder],
    [admin._id, admin],
    [staff._id, staff],
  ]);
  sessions = [
    makeSession('67f1f77bcf86cd799439201', founder._id),
    makeSession('67f1f77bcf86cd799439203', staff._id),
    makeSession('67f1f77bcf86cd799439204', staff._id),
    makeSession('67f1f77bcf86cd799439205', admin._id),
  ];

  User.findById = async (id) => cloneUser(findUser(id));
  User.findByIdAndUpdate = async (id, update) => {
    const current = findUser(id);
    if (!current) return null;
    if (update && update.$set) Object.assign(current, update.$set);
    return cloneUser(current);
  };
  SessionLog.find = (filter) => ({
    sort() {
      return {
        limit() {
          return {
            lean: async () => sessions.filter((session) => String(session.userId) === String(filter.userId)),
          };
        },
      };
    },
  });
  SessionLog.updateMany = async (filter, update) => {
    sessionUpdates.push({ filter, update });
    for (const session of sessions) {
      const userMatches = String(session.userId) === String(filter.userId);
      const statusMatches = !filter.status || session.status === filter.status;
      const currentExcluded = filter._id && filter._id.$ne && String(session._id) === String(filter._id.$ne);
      if (userMatches && statusMatches && !currentExcluded) Object.assign(session, update.$set || {});
    }
    return { modifiedCount: sessions.length };
  };
  OtpToken.updateMany = async (filter, update) => {
    otpTokenUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
  AuditLog.create = async (payload) => {
    auditLogs.push(payload);
    return payload;
  };
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
});

test('Founder can access Founder My Account and response never exposes passwords', async () => {
  const app = buildApp();
  const founder = findUser('507f1f77bcf86cd799439101');

  const res = await request(app)
    .get('/admin-api/admin/founder/my-account')
    .set('Authorization', `Bearer ${signToken(founder)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'founder@example.com');
  assert.equal(res.body.user.recoveryEmail, 'newspulse.team@gmail.com');
  assert.equal(res.body.user.staffId, 'NP-FND-0001');
  assert.equal(res.body.user.role, 'Founder');
  assert.equal(res.body.user.isFounder, true);
  assert.equal(res.body.user.isProtected, true);
  assert.equal(res.body.user.fullAccess, true);
  assert.equal(res.body.user.mustChangePassword, false);
  assert.deepEqual(res.body.user.badges, ['Founder', 'Full Access', 'Protected']);
  assert.equal(res.body.user.twoFactorStatus, 'not_configured');
  assert.equal(findUser(founder._id).recoveryEmail, 'newspulse.team@gmail.com');
  assert.equal(JSON.stringify(res.body).includes('password'), false);
  assert.ok(auditLogs.some((entry) => entry.action === 'USER_VIEWED_MY_ACCOUNT'));
});

test('Staff and Admin cannot access Founder My Account', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');
  const admin = findUser('507f1f77bcf86cd799439102');

  const staffRes = await request(app)
    .get('/admin-api/admin/founder/my-account')
    .set('Authorization', `Bearer ${signToken(staff)}`);
  const adminRes = await request(app)
    .get('/admin-api/admin/founder/my-account')
    .set('Authorization', `Bearer ${signToken(admin)}`);

  assert.equal(staffRes.status, 403);
  assert.equal(staffRes.body.code, 'FOUNDER_ONLY');
  assert.equal(adminRes.status, 403);
  assert.equal(adminRes.body.code, 'FOUNDER_ONLY');
  assert.equal(auditLogs.filter((entry) => entry.action === 'FOUNDER_MY_ACCOUNT_ACCESS_BLOCKED').length, 2);
});

test('Staff My Account is own-user only for non-Founder users', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');
  const admin = findUser('507f1f77bcf86cd799439102');
  const founder = findUser('507f1f77bcf86cd799439101');

  const staffRes = await request(app)
    .get('/admin-api/admin/my-account')
    .set('Authorization', `Bearer ${signToken(staff)}`);

  assert.equal(staffRes.status, 200);
  assert.equal(staffRes.body.user.email, 'staff@example.com');
  assert.equal(staffRes.body.user.staffId, 'NP-2026-0003');
  assert.equal(staffRes.body.user.role, 'reporter');
  assert.deepEqual(staffRes.body.user.assignedSections, ['Gujarat']);
  assert.deepEqual(staffRes.body.user.coverageAreas, ['Ahmedabad']);
  assert.equal(staffRes.body.user.mustChangePassword, true);
  assert.equal(JSON.stringify(staffRes.body).includes('passwordHash'), false);

  const adminRes = await request(app)
    .get('/admin-api/admin/my-account')
    .set('Authorization', `Bearer ${signToken(admin)}`);
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.body.user.email, 'admin@example.com');
  assert.equal(adminRes.body.user.isFounder, false);

  const founderOnStaffRoute = await request(app)
    .get('/admin-api/admin/my-account')
    .set('Authorization', `Bearer ${signToken(founder)}`);
  assert.equal(founderOnStaffRoute.status, 403);
  assert.equal(founderOnStaffRoute.body.code, 'STAFF_ACCOUNT_ONLY');
});

test('Current user endpoint returns own account area for Founder and Staff', async () => {
  const app = buildApp();
  const founder = findUser('507f1f77bcf86cd799439101');
  const staff = findUser('507f1f77bcf86cd799439103');

  const founderRes = await request(app)
    .get('/admin-api/admin/account/me')
    .set('Authorization', `Bearer ${signToken(founder)}`);
  const staffRes = await request(app)
    .get('/admin-api/admin/account/me')
    .set('Authorization', `Bearer ${signToken(staff)}`);

  assert.equal(founderRes.status, 200);
  assert.equal(founderRes.body.user.isFounder, true);
  assert.equal(founderRes.body.user.recoveryEmail, 'newspulse.team@gmail.com');
  assert.equal(staffRes.status, 200);
  assert.equal(staffRes.body.user.email, 'staff@example.com');
  assert.equal(staffRes.body.user.isFounder, false);
});

test('Own password change updates only the authenticated user and never returns password values', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');
  const founder = findUser('507f1f77bcf86cd799439101');
  const founderHashBefore = founder.passwordHash;

  const res = await request(app)
    .post('/admin-api/admin/account/change-password')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({
      userId: founder._id,
      currentPassword: 'StaffPass123',
      newPassword: 'StaffNew123',
      confirmPassword: 'StaffNew123',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Password updated successfully');
  assert.equal(await bcrypt.compare('StaffNew123', findUser(staff._id).passwordHash), true);
  assert.equal(findUser(staff._id).mustChangePassword, false);
  assert.equal(findUser(founder._id).passwordHash, founderHashBefore);
  assert.ok(findUser(staff._id).lastPasswordChangedAt);
  assert.equal(sessionUpdates[0].filter._id.$ne, staff.currentSessionId);
  assert.equal(otpTokenUpdates[0].filter.email, 'staff@example.com');
  assert.equal(otpTokenUpdates[0].update.$set.used, true);
  assert.equal(JSON.stringify(res.body).includes('StaffPass123'), false);
  assert.equal(JSON.stringify(res.body).includes('StaffNew123'), false);
  assert.equal(JSON.stringify(res.body).includes('passwordHash'), false);
  assert.ok(auditLogs.some((entry) => entry.action === 'PASSWORD_CHANGED'));
  assert.ok(auditLogs.some((entry) => entry.action === 'USER_CHANGED_OWN_PASSWORD'));
  assert.ok(auditLogs.some((entry) => entry.action === 'MUST_CHANGE_PASSWORD_COMPLETED'));
});

test('Own password change accepts safe frontend alias fields', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');

  const res = await request(app)
    .post('/admin-api/admin/account/change-password')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ oldPassword: 'StaffPass123', newPass: 'StaffAlias123', confirmNewPassword: 'StaffAlias123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'Password updated successfully');
  assert.equal(await bcrypt.compare('StaffAlias123', findUser(staff._id).passwordHash), true);
});

test('Own password change requires current password and matching confirmation', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');

  const mismatch = await request(app)
    .post('/admin-api/admin/account/change-password')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ currentPassword: 'StaffPass123', newPassword: 'StaffNew123', confirmPassword: 'OtherNew123' });

  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, 'PASSWORD_MISMATCH');

  const missing = await request(app)
    .post('/admin-api/admin/account/change-password')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ currentPassword: 'StaffPass123', newPassword: 'StaffNew123' });

  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'MISSING_FIELDS');
  assert.deepEqual(missing.body.receivedKeys.sort(), ['currentPassword', 'newPassword'].sort());
  assert.equal(JSON.stringify(missing.body).includes('StaffPass123'), false);

  const wrongCurrent = await request(app)
    .post('/admin-api/admin/account/change-password')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ currentPassword: 'WrongPass123', newPassword: 'StaffNew123', confirmPassword: 'StaffNew123' });

  assert.equal(wrongCurrent.status, 401);
  assert.equal(wrongCurrent.body.code, 'INVALID_CURRENT_PASSWORD');
  assert.ok(auditLogs.some((entry) => entry.action === 'USER_CHANGE_OWN_PASSWORD_FAILED'));
});

test('Own sessions and logout-all devices are scoped to the authenticated user', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');
  const founder = findUser('507f1f77bcf86cd799439101');

  const sessionsRes = await request(app)
    .get('/admin-api/admin/account/sessions')
    .set('Authorization', `Bearer ${signToken(staff)}`);

  assert.equal(sessionsRes.status, 200);
  assert.equal(sessionsRes.body.sessions.length, 2);
  assert.ok(sessionsRes.body.sessions.every((session) => session.ipAddress === '127.0.0.1'));
  assert.equal(JSON.stringify(sessionsRes.body).includes('password'), false);

  const logoutRes = await request(app)
    .post('/admin-api/admin/account/logout-all-my-devices')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ userId: founder._id });

  assert.equal(logoutRes.status, 200);
  assert.equal(sessionUpdates.at(-1).filter.userId, staff._id);
  assert.equal(findUser(staff._id).tokenVersion, 1);
  assert.equal(findUser(founder._id).tokenVersion, 0);
  assert.equal(sessions.find((session) => session.userId === founder._id).status, 'active');
  assert.ok(auditLogs.some((entry) => entry.action === 'USER_LOGOUT_ALL_OWN_DEVICES'));
});

test('Profile endpoint blocks Staff ID, role, department, permissions, and Founder protected edits', async () => {
  const app = buildApp();
  const staff = findUser('507f1f77bcf86cd799439103');
  const founder = findUser('507f1f77bcf86cd799439101');

  const blocked = await request(app)
    .patch('/admin-api/admin/account/profile')
    .set('Authorization', `Bearer ${signToken(staff)}`)
    .send({ fullName: 'Staff Updated', staffId: 'NP-2026-9999', role: 'admin', department: 'Administration', permissions: ['team.manage'] });

  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'PROTECTED_FIELDS');
  assert.equal(findUser(staff._id).staffId, 'NP-2026-0003');
  assert.equal(findUser(staff._id).role, 'reporter');

  const founderEdit = await request(app)
    .patch('/admin-api/admin/account/profile')
    .set('Authorization', `Bearer ${signToken(founder)}`)
    .send({ fullName: 'Founder Updated' });

  assert.equal(founderEdit.status, 403);
  assert.equal(founderEdit.body.code, 'FOUNDER_PROTECTED');
});
