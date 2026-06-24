process.env.JWT_SECRET = process.env.JWT_SECRET || 'staff-task-management-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const User = require('../models/User');
const Role = require('../models/Role');
const StaffTask = require('../models/StaffTask');
const AuditLog = require('../models/AuditLog');
const adminTeamRouter = require('../routes/adminTeam.routes');

let currentUser;
let usersById;
let createdTasks;
let auditLogs;
let originalReadyState;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/team', adminTeamRouter);
  return app;
}

function makeUser(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439201',
    email: overrides.email || 'staff@example.com',
    staffId: overrides.staffId || 'NP-STF-0201',
    name: overrides.name || 'Staff',
    fullName: overrides.name || 'Staff',
    role: overrides.role || 'reporter',
    roleName: overrides.role || 'reporter',
    permissions: [],
    moduleAccessOverride: [],
    specialRightsOverride: [],
    taskRightsOverride: [],
    accountControlRightsOverride: [],
    status: 'active',
    accountStatus: 'active',
    loginAllowed: true,
    tokenVersion: 0,
    isFounder: overrides.role === 'founder',
    isProtected: overrides.role === 'founder',
    ...overrides,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), email: user.email, role: user.role, name: user.name, tokenVersion: user.tokenVersion || 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

test.beforeEach(() => {
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  createdTasks = [];
  auditLogs = [];
  currentUser = makeUser();
  const founder = makeUser({
    _id: '507f1f77bcf86cd799439211',
    email: 'kiran@newspulse.co.in',
    staffId: 'NP-FND-0001',
    name: 'Founder',
    role: 'founder',
    isFounder: true,
    isProtected: true,
  });
  usersById = new Map([[String(currentUser._id), currentUser], [String(founder._id), founder]]);

  User.findById = async (id) => usersById.get(String(id)) || null;
  User.findOne = () => ({ lean: async () => null });
  User.findByIdAndUpdate = async (id, update) => {
    const user = usersById.get(String(id));
    if (!user) return null;
    if (update.$set) Object.assign(user, update.$set);
    usersById.set(String(id), user);
    return user;
  };
  Role.findById = () => ({ lean: async () => null });
  Role.findOne = () => ({ lean: async () => null });
  AuditLog.create = async (payload) => {
    auditLogs.push(payload);
    return payload;
  };
  StaffTask.create = async (payload) => {
    const task = { _id: new mongoose.Types.ObjectId(), ...payload };
    createdTasks.push(task);
    return task;
  };
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
});

test('staff_tasks module access is separate from task_create right', async () => {
  const app = buildApp();
  currentUser = makeUser({ moduleAccessOverride: ['staff_tasks'] });
  usersById.set(String(currentUser._id), currentUser);
  let token = signToken(currentUser);

  const blocked = await request(app)
    .post('/api/admin/team/tasks')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'SEO review', taskCategory: 'SEO Task', taskLevel: 'Staff Level' });

  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.message, 'Action denied. Founder permission is required.');
  assert.equal(createdTasks.length, 0);

  currentUser.taskRightsOverride = ['task_create'];
  usersById.set(String(currentUser._id), currentUser);
  token = signToken(currentUser);

  const created = await request(app)
    .post('/api/admin/team/tasks')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'SEO review', taskCategory: 'SEO Task', taskLevel: 'Staff Level', assignedToStaffId: 'NP-STF-0201' });

  assert.equal(created.status, 201);
  assert.equal(created.body.task.title, 'SEO review');
  assert.equal(created.body.task.assignedByStaffId, 'NP-STF-0201');
  assert.equal(createdTasks.length, 1);
  assert.ok(auditLogs.some((entry) => entry.action === 'TASK_CREATED'));
});

test('staff routes cannot mutate protected Founder account', async () => {
  const app = buildApp();
  const actor = makeUser({ role: 'founder', email: 'founder@example.com', staffId: 'NP-FND-0001', isFounder: true, isProtected: true });
  usersById.set(String(actor._id), actor);
  const founderTargetId = '507f1f77bcf86cd799439211';

  const res = await request(app)
    .patch(`/api/admin/team/staff/${founderTargetId}`)
    .set('Authorization', `Bearer ${signToken(actor)}`)
    .send({ fullName: 'Changed Founder' });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FOUNDER_PROTECTED');
  assert.equal(usersById.get(founderTargetId).fullName, 'Founder');
  assert.ok(auditLogs.some((entry) => entry.action === 'BLOCKED_FOUNDER_STAFF_ACTION'));
});