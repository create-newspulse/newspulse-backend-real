process.env.JWT_SECRET = process.env.JWT_SECRET || 'role-access-routes-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const User = require('../models/User');
const Role = require('../models/Role');
const FinanceRecord = require('../models/FinanceRecord');
const AuditLog = require('../models/AuditLog');
const rolesRoutes = require('../routes/roles.routes');
const accessRoutes = require('../routes/access.routes');
const financeRoutes = require('../routes/finance.routes');
const { requireAuth, requireModuleAccess, requireSpecialRight } = require('../middleware/requireAuth');
const { ROLE_DEFAULT_ACCESS, TEAM_ROLES } = require('../lib/teamAccess');

let originalReadyState;
let currentUser;
let createdRole;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/roles', rolesRoutes);
  app.use('/api/access', accessRoutes);
  app.use('/api/finance', financeRoutes);
  app.get('/secure-live-tv', requireAuth, requireModuleAccess('live_tv'), (_req, res) => res.json({ ok: true }));
  app.get('/secure-analytics', requireAuth, requireModuleAccess('analytics'), (_req, res) => res.json({ ok: true }));
  app.get('/finance-founder-only', requireAuth, requireModuleAccess('finance_desk'), requireSpecialRight('finance_approve_payment'), (_req, res) => res.json({ ok: true }));
  return app;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      name: user.name,
      tokenVersion: user.tokenVersion || 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeUser(overrides) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439031',
    email: overrides.email || 'staff@example.com',
    name: overrides.name || 'Staff',
    fullName: overrides.name || 'Staff',
    role: overrides.role || 'reporter',
    roleName: overrides.roleName || overrides.role || 'reporter',
    permissions: overrides.permissions || [],
    moduleAccessOverride: overrides.moduleAccessOverride || [],
    specialRightsOverride: overrides.specialRightsOverride || [],
    status: 'active',
    tokenVersion: 0,
    isFounder: overrides.role === 'founder',
    isProtected: overrides.role === 'founder',
    ...overrides,
  };
}

test.beforeEach(() => {
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  createdRole = null;
  currentUser = makeUser({ role: 'founder', email: 'founder@example.com', name: 'Founder' });

  User.findById = async (id) => (String(id) === String(currentUser._id) ? currentUser : null);
  User.countDocuments = async () => 0;
  AuditLog.create = async () => ({ ok: true });

  Role.updateOne = async () => ({ acknowledged: true });
  Role.findOne = (filter) => ({
    lean: async () => {
      if (createdRole && filter.slug === createdRole.slug) return createdRole;
      if (filter.slug === 'reporter') return { name: 'Reporter', slug: 'reporter', moduleAccess: ['dashboard'], specialRights: [] };
      return null;
    },
  });
  Role.findById = () => ({ lean: async () => null });
  Role.find = () => ({ sort: () => ({ lean: async () => (createdRole ? [createdRole] : []) }) });
  Role.create = async (payload) => {
    createdRole = { _id: '507f1f77bcf86cd799439099', ...payload };
    return createdRole;
  };
  Role.deleteOne = async () => ({ deletedCount: 1 });

  FinanceRecord.create = async (payload) => ({ _id: '507f1f77bcf86cd799439088', ...payload });
  FinanceRecord.find = () => ({
    sort: () => ({
      limit: () => ({ lean: async () => [] }),
    }),
  });
  FinanceRecord.findOneAndUpdate = async () => null;
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
});

test('Founder can create custom roles and non-founder receives Founder-required 403', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const createRes = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      name: 'Weekend Editor',
      moduleAccess: ['dashboard', 'draft_desk'],
      specialRights: ['news_approve'],
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.role.slug, 'weekend-editor');
  assert.deepEqual(createRes.body.data.role.moduleAccess, ['dashboard', 'draft_desk']);

  currentUser = makeUser({ _id: '507f1f77bcf86cd799439032', role: 'editor', email: 'editor@example.com', name: 'Editor' });
  const editorToken = signToken(currentUser);

  const blockedRes = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ name: 'Blocked Role' });

  assert.equal(blockedRes.status, 403);
  assert.deepEqual(blockedRes.body, {
    success: false,
    message: 'Access denied. Founder permission required.',
  });
});

test('module middleware blocks unauthorized staff and honors user-specific overrides', async () => {
  const app = buildApp();
  currentUser = makeUser({ role: 'reporter', email: 'reporter@example.com', name: 'Reporter' });
  let token = signToken(currentUser);

  const blockedRes = await request(app)
    .get('/secure-live-tv')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(blockedRes.status, 403);
  assert.equal(blockedRes.body.success, false);

  currentUser = makeUser({ role: 'reporter', email: 'reporter@example.com', name: 'Reporter', moduleAccessOverride: ['analytics'] });
  token = signToken(currentUser);

  const allowedRes = await request(app)
    .get('/secure-analytics')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(allowedRes.status, 200);
  assert.equal(allowedRes.body.ok, true);
});

test('role order separates Finance & Accounts from Ads & Revenue Growth', () => {
  assert.deepEqual(TEAM_ROLES, [
    'founder',
    'admin',
    'finance & accounts manager',
    'manager',
    'editor',
    'copy editor',
    'fact checker',
    'reporter',
    'live tv controller',
    'video editor',
    'ads & revenue growth manager',
    'social media manager',
    'tech support',
    'intern',
  ]);
});

test('Ads & Revenue Growth Manager has no finance rights while Finance manager lacks Founder-only finance rights', () => {
  const adsAccess = ROLE_DEFAULT_ACCESS['ads & revenue growth manager'];
  assert.ok(adsAccess.moduleAccess.includes('ads_manager'));
  assert.equal(adsAccess.moduleAccess.includes('finance_desk'), false);
  assert.equal(adsAccess.specialRights.some((right) => right.startsWith('finance_')), false);

  const financeAccess = ROLE_DEFAULT_ACCESS['finance & accounts manager'];
  assert.ok(financeAccess.moduleAccess.includes('finance_desk'));
  assert.ok(financeAccess.specialRights.includes('finance_prepare_monthly_report'));
  assert.ok(financeAccess.specialRights.includes('finance_view_sponsor_payment_status'));
  assert.equal(financeAccess.specialRights.includes('finance_approve_payment'), false);
  assert.equal(financeAccess.specialRights.includes('finance_delete_record'), false);
  assert.equal(financeAccess.specialRights.includes('finance_change_bank_details'), false);
  assert.equal(financeAccess.specialRights.includes('finance_change_payment_gateway'), false);
  assert.equal(financeAccess.specialRights.includes('finance_approve_withdrawal'), false);
  assert.equal(financeAccess.specialRights.includes('finance_final_report_approval'), false);
});

test('finance routes allow finance records for Finance manager and block Ads/Growth finance access', async () => {
  const app = buildApp();

  currentUser = makeUser({ role: 'finance & accounts manager', email: 'finance@example.com', name: 'Finance Manager' });
  let token = signToken(currentUser);

  const createInvoice = await request(app)
    .post('/api/finance/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Sponsor Invoice', amount: 12000, sponsorName: 'Pulse Sponsor' });

  assert.equal(createInvoice.status, 201);
  assert.equal(createInvoice.body.data.record.type, 'invoice');
  assert.equal(createInvoice.body.data.record.amount, 12000);

  const founderOnly = await request(app)
    .get('/finance-founder-only')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(founderOnly.status, 403);

  currentUser = makeUser({ role: 'ads & revenue growth manager', email: 'ads@example.com', name: 'Ads Manager' });
  token = signToken(currentUser);

  const blockedSummary = await request(app)
    .get('/api/finance/summary')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(blockedSummary.status, 403);
});