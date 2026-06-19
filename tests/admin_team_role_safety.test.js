process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-role-safety-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { TEAM_ROLES } = require('../lib/teamAccess');

let usersById;
let usersByEmail;
let originalReadyState;

function cloneUser(user) {
  if (!user) return null;
  return {
    ...user,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    sections: Array.isArray(user.sections) ? [...user.sections] : [],
    assignedSections: Array.isArray(user.assignedSections) ? [...user.assignedSections] : [],
    coverageAreas: Array.isArray(user.coverageAreas) ? [...user.coverageAreas] : [],
  };
}

function seedUsers() {
  const founder = {
    _id: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    name: 'Founder',
    role: 'founder',
    designation: null,
    permissions: [],
    status: 'active',
    mustChangePassword: false,
    mustResetPassword: false,
    forceReset: false,
    tokenVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
  };
  const editor = {
    _id: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    name: 'Editor',
    role: 'editor',
    designation: 'Desk Editor',
    permissions: [],
    status: 'active',
    mustChangePassword: false,
    mustResetPassword: false,
    forceReset: false,
    tokenVersion: 0,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    lastLoginAt: null,
  };
  usersById = new Map([
    [founder._id, founder],
    [editor._id, editor],
  ]);
  usersByEmail = new Map([
    [founder.email, founder._id],
    [editor.email, editor._id],
  ]);
}

function makeFindChain(users) {
  return {
    sort() {
      return {
        lean: async () => users.map(cloneUser),
      };
    },
  };
}

User.findById = async (id) => cloneUser(usersById.get(String(id)));
User.findOne = (filter) => ({
  lean: async () => {
    const id = usersByEmail.get(String(filter && filter.email || '').toLowerCase());
    return cloneUser(id ? usersById.get(id) : null);
  },
});
User.find = () => makeFindChain(Array.from(usersById.values()));
User.create = async (payload) => {
  const _id = '507f1f77bcf86cd799439099';
  const created = {
    _id,
    lastLoginAt: null,
    ...payload,
  };
  usersById.set(_id, created);
  usersByEmail.set(String(created.email).toLowerCase(), _id);
  return cloneUser(created);
};
User.findByIdAndUpdate = async (id, update) => {
  const current = usersById.get(String(id));
  if (!current) return null;
  const next = {
    ...current,
    ...(update && update.$set ? update.$set : {}),
    tokenVersion: current.tokenVersion + (update && update.$inc && typeof update.$inc.tokenVersion === 'number' ? update.$inc.tokenVersion : 0),
  };
  usersById.set(String(id), next);
  if (next.email) usersByEmail.set(String(next.email).toLowerCase(), String(id));
  return cloneUser(next);
};

AuditLog.create = async () => ({ ok: true });

const router = require('../routes/adminTeam.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  app.use('/api/team', router);
  return app;
}

function signToken({ sub, email, role, name, tokenVersion = 0 }) {
  return jwt.sign(
    {
      sub,
      email,
      role,
      name,
      tokenVersion,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

test.beforeEach(() => {
  seedUsers();
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
});

test('GET /api/admin/team/users exposes requested team roles while preserving founder record', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const res = await request(app)
    .get('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.availableRoles, TEAM_ROLES);
  assert.deepEqual(res.body.data.availableRoles, TEAM_ROLES);
  assert.ok(res.body.users.some((user) => user.email === 'editor@example.com'));
  const founder = res.body.users.find((user) => user.email === 'newspulse.team@gmail.com');
  assert.ok(founder);
  assert.equal(founder.role, 'founder');
  assert.equal(founder.status, 'active');
  assert.equal(founder.department, 'Founder / Ownership');
  assert.deepEqual(founder.assignedSections, []);
  assert.deepEqual(founder.coverageAreas, []);
});

test('POST /api/admin/team/users rejects blank email, founder email, and invalid roles', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const blankEmail = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Editor', email: '   ' });

  assert.equal(blankEmail.status, 400);
  assert.equal(blankEmail.body.code, 'INVALID_EMAIL');

  const founderEmail = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Editor', email: 'newspulse.team@gmail.com', role: 'editor' });

  assert.equal(founderEmail.status, 409);
  assert.equal(founderEmail.body.code, 'EMAIL_EXISTS');

  const invalidRole = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Editor', email: 'new-editor@example.com', role: 'unknown-role' });

  assert.equal(invalidRole.status, 400);
  assert.equal(invalidRole.body.code, 'INVALID_ROLE');
});

test('POST /api/admin/team/users creates intern users by default with one-time temporary password', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const res = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Fresh Editor', email: 'fresh-editor@example.com' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.role, 'intern');
  assert.equal(typeof res.body.data.temporaryPassword, 'string');
  assert.equal(typeof res.body.data.user.passwordHash, 'undefined');
  assert.equal(usersById.get('507f1f77bcf86cd799439099').role, 'intern');
  assert.equal(res.body.data.user.department, 'Training / Internship');
});

test('team create-user defaults editor department and Gujarat coverage while cleaning assigned section city values', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const createEditor = await request(app)
    .post('/api/team/create-user')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      fullName: 'City Editor',
      email: 'city-editor@example.com',
      role: 'editor',
      assignedSections: ['Gujarat'],
      coverageAreas: [],
    });

  assert.equal(createEditor.status, 201);
  assert.equal(createEditor.body.data.user.department, 'Editorial / Newsroom');
  assert.deepEqual(createEditor.body.data.user.assignedSections, ['Gujarat']);
  assert.deepEqual(createEditor.body.data.user.sections, ['Gujarat']);
  assert.deepEqual(createEditor.body.data.user.coverageAreas, ['All Gujarat']);

  const cleaned = await request(app)
    .patch('/api/team/users/507f1f77bcf86cd799439099')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      assignedSections: ['Business', 'Ahmedabad', 'Surat', 'Rajkot', 'Vadodara'],
      coverageAreas: ['South Gujarat'],
    });

  assert.equal(cleaned.status, 200);
  assert.deepEqual(cleaned.body.data.user.assignedSections, ['Business']);
  assert.deepEqual(cleaned.body.data.user.sections, ['Business']);
  assert.deepEqual(cleaned.body.data.user.coverageAreas, ['Ahmedabad', 'Surat', 'Rajkot', 'Vadodara', 'South Gujarat']);
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439099').assignedSections, ['Business']);
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439099').coverageAreas, ['Ahmedabad', 'Surat', 'Rajkot', 'Vadodara', 'South Gujarat']);
});

test('GET /api/team/options returns organizational dropdown metadata', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const res = await request(app)
    .get('/api/team/options')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(res.status, 200);
  assert.ok(res.body.departments.includes('Editorial / Newsroom'));
  assert.ok(res.body.assignedSections.includes('Gujarat'));
  assert.ok(res.body.coverageAreas.includes('All Gujarat'));
  assert.equal(res.body.roleDepartmentDefaults.editor, 'Editorial / Newsroom');
});

test('Founder can create Admin but delegated non-founder cannot create Admin', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const founderCreate = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Admin User', email: 'new-admin@example.com', role: 'admin' });

  assert.equal(founderCreate.status, 201);
  assert.equal(founderCreate.body.data.user.role, 'admin');

  usersById.get('507f1f77bcf86cd799439012').permissions = ['auth.create_user'];
  const editorToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'editor',
    name: 'Editor',
  });

  const delegatedCreate = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ fullName: 'Blocked Admin', email: 'blocked-admin@example.com', role: 'admin' });

  assert.equal(delegatedCreate.status, 403);
  assert.equal(delegatedCreate.body.code, 'FOUNDER_REQUIRED');
});

test('/api/team create-user returns temporary password once and user reads never expose passwords', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const createRes = await request(app)
    .post('/api/team/create-user')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Field Reporter', email: 'field@example.com', role: 'reporter', generateTemporaryPassword: true });

  assert.equal(createRes.status, 201);
  assert.equal(typeof createRes.body.data.temporaryPassword, 'string');
  assert.equal(typeof createRes.body.data.user.passwordHash, 'undefined');
  assert.equal(usersById.get('507f1f77bcf86cd799439099').passwordHash.startsWith('$2'), true);

  const readRes = await request(app)
    .get('/api/team/users/507f1f77bcf86cd799439099')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(readRes.status, 200);
  assert.equal(typeof readRes.body.data.temporaryPassword, 'undefined');
  assert.equal(typeof readRes.body.data.tempPassword, 'undefined');
  assert.equal(typeof readRes.body.data.user.passwordHash, 'undefined');
});

test('normal team endpoints cannot suspend or force-reset the founder account', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const suspendRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439011/suspend')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(suspendRes.status, 403);
  assert.equal(suspendRes.body.code, 'FOUNDER_PROTECTED');

  const resetRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439011/force-reset')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(resetRes.status, 403);
  assert.equal(resetRes.body.code, 'FOUNDER_PROTECTED');
});

test('legacy non-founder team managers cannot use mutating team endpoints', async () => {
  const app = buildApp();
  const legacyAdminToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'editor',
    name: 'Editor',
  });

  const res = await request(app)
    .post('/api/admin/team/users')
    .set('Authorization', `Bearer ${legacyAdminToken}`)
    .send({ fullName: 'Blocked Create', email: 'blocked@example.com', role: 'editor' });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});