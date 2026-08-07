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
const SiteSettings = require('../models/SiteSettings');
const rolesRoutes = require('../routes/roles.routes');
const accessRoutes = require('../routes/access.routes');
const financeRoutes = require('../routes/finance.routes');
const { requireAuth, requireModuleAccess, requireSpecialRight } = require('../middleware/requireAuth');
const { ROLE_DEFAULT_ACCESS, TEAM_ROLES } = require('../lib/teamAccess');

let originalReadyState;
let originalDb;
let currentUser;
let createdRole;
let updatedRole;
let unsafeStoredRole;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/roles', rolesRoutes);
  app.use('/api/access', accessRoutes);
  app.use('/api/finance', financeRoutes);
  app.get('/secure-live-tv', requireAuth, requireModuleAccess('live_tv'), (_req, res) => res.json({ ok: true }));
  app.get('/secure-analytics', requireAuth, requireModuleAccess('analytics'), (_req, res) => res.json({ ok: true }));
  app.get('/secure-add-news', requireAuth, requireModuleAccess('add_news'), (_req, res) => res.json({ ok: true }));
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
    accessVersion: overrides.accessVersion || 0,
    isFounder: overrides.role === 'founder',
    isProtected: overrides.role === 'founder',
    ...overrides,
  };
}

test.beforeEach(() => {
  originalReadyState = mongoose.connection.readyState;
  originalDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = { collection: () => ({}) };
  createdRole = null;
  updatedRole = null;
  unsafeStoredRole = null;
  currentUser = makeUser({ role: 'founder', email: 'founder@example.com', name: 'Founder' });

  User.findById = async (id) => (String(id) === String(currentUser._id) ? currentUser : null);
  User.countDocuments = async () => 0;
  AuditLog.create = async () => ({ ok: true });
  SiteSettings.findOne = async () => ({
    adminModulePolicy: {
      modulePolicies: {
        liveTv: 'available',
        analytics: 'available',
        financeDesk: 'available',
      },
      version: 1,
      updatedAt: new Date(),
      updatedBy: 'test',
      auditReason: 'test policy',
    },
  });

  Role.updateOne = async () => ({ acknowledged: true });
  Role.findOne = (filter) => ({
    lean: async () => {
      if (createdRole && filter.slug === createdRole.slug) return createdRole;
      if (updatedRole && filter.slug === updatedRole.slug) return updatedRole;
      if (filter.slug === 'reporter') return { name: 'Reporter', slug: 'reporter', moduleAccess: ['dashboard'], specialRights: [] };
      if (filter.slug === 'desk-editor') return { name: 'Desk Editor', slug: 'desk-editor', moduleAccess: ['add_news'], specialRights: ['news_create'] };
      return null;
    },
  });
  Role.findById = async (id) => {
    if (String(id) === '507f1f77bcf86cd799439077') {
      return {
        _id: '507f1f77bcf86cd799439077',
        name: 'Weekend Editor',
        slug: 'weekend-editor',
        description: '',
        sortOrder: 100,
        isSystemRole: false,
        isProtected: false,
        moduleAccess: ['dashboard'],
        specialRights: ['news_create'],
        taskRights: [],
        save: async function save() { updatedRole = { ...this }; return this; },
      };
    }
    if (String(id) === '507f1f77bcf86cd799439078') {
      return {
        _id: '507f1f77bcf86cd799439078',
        name: 'Founder',
        slug: 'founder',
        isSystemRole: true,
        isProtected: true,
        moduleAccess: ['safe_zone'],
        specialRights: ['founder_account_control'],
        taskRights: [],
        save: async function save() { updatedRole = { ...this }; return this; },
      };
    }
    return null;
  };
  Role.find = () => ({ sort: () => ({ lean: async () => [createdRole, unsafeStoredRole].filter(Boolean) }) });
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
  mongoose.connection.db = originalDb;
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

test('role templates accept normal newsroom modules and editorial workflow rights', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const res = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      name: 'Editorial Head Template',
      description: 'Newsroom publishing preset',
      sortOrder: 42,
      moduleAccess: ['dashboard', 'addNews', 'manageNews', 'draftDesk', 'editorial', 'seo', 'moderation'],
      specialRights: ['news_create', 'news_edit', 'news_submit', 'news_approve', 'news_reject_send_back', 'news_publish', 'news_schedule', 'news_restore', 'news_pin_breaking'],
      taskRights: ['task_create', 'task_assign', 'task_edit', 'task_update_status', 'task_complete', 'task_close', 'task_view_team', 'task_comment', 'task_escalate'],
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.role.name, 'Editorial Head Template');
  assert.deepEqual(res.body.role.moduleAccess, ['dashboard', 'add_news', 'manage_news', 'draft_desk', 'editorial', 'seo', 'moderation']);
  assert.ok(res.body.role.specialRights.includes('news_publish'));
  assert.ok(res.body.role.taskRights.includes('task_assign'));
});

test('role templates allow normal Live TV workflow but reject emergency Live TV control', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const allowed = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      name: 'Live TV Producer Template',
      moduleAccess: ['dashboard', 'broadcastCenter', 'liveTv', 'media'],
      specialRights: ['live_tv_prepare', 'live_tv_edit_title', 'live_tv_add_stream_link', 'live_tv_update_ticker', 'live_tv_schedule', 'live_tv_start', 'live_tv_stop'],
    });

  assert.equal(allowed.status, 201);
  assert.deepEqual(allowed.body.role.moduleAccess, ['dashboard', 'broadcast_center', 'live_tv', 'media']);
  assert.equal(allowed.body.role.specialRights.includes('live_tv_emergency_stop'), false);

  createdRole = null;
  const blocked = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Emergency Live TV Template', moduleAccess: ['liveTv'], specialRights: ['live_tv_emergency_stop'] });

  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'ROLE_TEMPLATE_FORBIDDEN_PERMISSION');
  assert.equal(blocked.body.permissionKey, 'live_tv_emergency_stop');
  assert.equal(createdRole, null);
});

test('role templates reject forbidden Founder Safe Zone staff-control role-admin and critical finance permissions', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);
  const invalidCases = [
    { payload: { name: 'Safe Zone Template', moduleAccess: ['safeZone'] }, key: 'safeZone' },
    { payload: { name: 'Founder Access Template', moduleAccess: ['founderAccessControl'] }, key: 'founderAccessControl' },
    { payload: { name: 'Founder Control Template', specialRights: ['founder_account_control'] }, key: 'founder_account_control' },
    { payload: { name: 'Founder Grant Template', specialRights: ['grant_founder_only_rights'] }, key: 'grant_founder_only_rights' },
    { payload: { name: 'Staff Admin Template', specialRights: ['staff_reset_password'] }, key: 'staff_reset_password' },
    { payload: { name: 'Account Control Grant Template', specialRights: ['grant_account_control_rights'] }, key: 'grant_account_control_rights' },
    { payload: { name: 'Role Admin Template', specialRights: ['role_create'] }, key: 'role_create' },
    { payload: { name: 'Banking Template', specialRights: ['finance_change_bank_details'] }, key: 'finance_change_bank_details' },
  ];

  for (const item of invalidCases) {
    createdRole = null;
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${founderToken}`)
      .send(item.payload);

    assert.equal(res.status, 400, item.key);
    assert.equal(res.body.code, 'ROLE_TEMPLATE_FORBIDDEN_PERMISSION');
    assert.equal(res.body.permissionKey, item.key);
    assert.equal(createdRole, null);
  }
});

test('role templates reject unknown module and right keys without partial persistence', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const unknownModule = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Unknown Module Template', moduleAccess: ['madeUpModule'] });

  assert.equal(unknownModule.status, 400);
  assert.equal(unknownModule.body.code, 'ROLE_TEMPLATE_UNKNOWN_PERMISSION');
  assert.equal(unknownModule.body.permissionKey, 'madeUpModule');
  assert.equal(createdRole, null);

  const unknownRight = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Unknown Right Template', specialRights: ['news_launch_rocket'] });

  assert.equal(unknownRight.status, 400);
  assert.equal(unknownRight.body.code, 'ROLE_TEMPLATE_UNKNOWN_PERMISSION');
  assert.equal(unknownRight.body.permissionKey, 'news_launch_rocket');
  assert.equal(createdRole, null);
});

test('protected Founder role cannot be modified and custom names cannot clone Founder authority', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const protectedRes = await request(app)
    .patch('/api/roles/507f1f77bcf86cd799439078')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Founder', moduleAccess: ['dashboard'] });

  assert.equal(protectedRes.status, 403);
  assert.equal(protectedRes.body.code, 'FOUNDER_ROLE_PROTECTED');

  const cloneRes = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Custom Manager', moduleAccess: ['dashboard'], specialRights: ['founder_account_control'] });

  assert.equal(cloneRes.status, 400);
  assert.equal(cloneRes.body.code, 'ROLE_TEMPLATE_FORBIDDEN_PERMISSION');
});

test('editing a role template does not mutate existing staff permission fields', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);
  const staff = makeUser({
    _id: '507f1f77bcf86cd799439033',
    role: 'editor',
    roleId: '507f1f77bcf86cd799439077',
    moduleAccessOverride: ['add_news'],
    specialRightsOverride: ['news_create'],
  });
  const before = {
    roleId: staff.roleId,
    moduleAccessOverride: staff.moduleAccessOverride.slice(),
    specialRightsOverride: staff.specialRightsOverride.slice(),
  };

  const res = await request(app)
    .patch('/api/roles/507f1f77bcf86cd799439077')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ moduleAccess: ['dashboard', 'manage_news'], specialRights: ['news_approve'] });

  assert.equal(res.status, 200);
  assert.deepEqual(staff.moduleAccessOverride, before.moduleAccessOverride);
  assert.deepEqual(staff.specialRightsOverride, before.specialRightsOverride);
  assert.equal(staff.roleId, before.roleId);
});

test('custom Admin role template does not receive Account Control rights automatically', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);

  const res = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ name: 'Custom Admin Template', moduleAccess: ['dashboard', 'analytics'], specialRights: ['ads_view'] });

  assert.equal(res.status, 201);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.role, 'accountControlRights'), false);
  assert.equal(res.body.role.specialRights.includes('staff_reset_password'), false);
});

test('Founder global module policy still overrides role template module suggestions', async () => {
  const app = buildApp();
  currentUser = makeUser({
    role: 'editor',
    email: 'desk@example.com',
    name: 'Desk Editor',
    roleId: '507f1f77bcf86cd799439077',
  });
  const token = signToken(currentUser);
  SiteSettings.findOne = async () => ({
    adminModulePolicy: {
      modulePolicies: { addNews: 'founder_only' },
      version: 2,
      updatedAt: new Date(),
      updatedBy: 'founder',
      auditReason: 'founder only add news',
    },
  });

  const res = await request(app)
    .get('/secure-add-news')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 403);
  assert.equal(currentUser.moduleAccessOverride.length, 0);
});

test('existing unsafe role-template data is reported but not silently reset on list', async () => {
  const app = buildApp();
  const founderToken = signToken(currentUser);
  unsafeStoredRole = {
    _id: '507f1f77bcf86cd799439066',
    name: 'Unsafe Existing Template',
    slug: 'unsafe-existing-template',
    description: '',
    sortOrder: 200,
    isSystemRole: false,
    isProtected: false,
    moduleAccess: ['dashboard', 'safe_zone'],
    specialRights: ['news_create', 'staff_reset_password'],
    taskRights: [],
  };

  const res = await request(app)
    .get('/api/roles')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.unsafeRoleTemplates.length, 1);
  assert.equal(res.body.unsafeRoleTemplates[0].role.slug, 'unsafe-existing-template');
  assert.ok(res.body.unsafeRoleTemplates[0].unsafePermissions.some((item) => item.key === 'safe_zone'));
  assert.deepEqual(unsafeStoredRole.moduleAccess, ['dashboard', 'safe_zone']);
  assert.deepEqual(unsafeStoredRole.specialRights, ['news_create', 'staff_reset_password']);
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

test('finance routes require explicit staff module access and block Ads/Growth finance access', async () => {
  const app = buildApp();

  currentUser = makeUser({ role: 'finance & accounts manager', email: 'finance@example.com', name: 'Finance Manager' });
  let token = signToken(currentUser);

  const blockedByMissingStaffAccess = await request(app)
    .post('/api/finance/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Sponsor Invoice', amount: 12000, sponsorName: 'Pulse Sponsor' });

  assert.equal(blockedByMissingStaffAccess.status, 403);

  currentUser = makeUser({ role: 'finance & accounts manager', email: 'finance@example.com', name: 'Finance Manager', moduleAccessOverride: ['finance_desk'] });
  token = signToken(currentUser);

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