process.env.JWT_SECRET = process.env.JWT_SECRET || 'team-role-safety-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');
const Role = require('../models/Role');
const News = require('../models/News');
const FinanceRecord = require('../models/FinanceRecord');
const AuditLog = require('../models/AuditLog');
const OtpToken = require('../models/OtpToken');
const SessionLog = require('../models/SessionLog');
const AccountControlDelegation = require('../models/AccountControlDelegation');
const SiteSettings = require('../models/SiteSettings');
const Counter = require('../models/Counter');
const { TEAM_ROLES } = require('../lib/teamAccess');
const { CANONICAL_ADMIN_MODULE_KEYS } = require('../services/founderAccessPolicyService');

let usersById;
let usersByEmail;
let delegationsById;
let auditLogs;
let otpTokenUpdates;
let sessionUpdates;
let originalReadyState;
let originalConnectionDb;
let siteSettingsDoc;

function cloneUser(user) {
  if (!user) return null;
  return {
    ...user,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    moduleAccessOverride: Array.isArray(user.moduleAccessOverride) ? [...user.moduleAccessOverride] : [],
    moduleAccessStates: user.moduleAccessStates && typeof user.moduleAccessStates === 'object' ? { ...user.moduleAccessStates } : user.moduleAccessStates,
    specialRightsOverride: Array.isArray(user.specialRightsOverride) ? [...user.specialRightsOverride] : [],
    taskRightsOverride: Array.isArray(user.taskRightsOverride) ? [...user.taskRightsOverride] : [],
    accountControlRightsOverride: Array.isArray(user.accountControlRightsOverride) ? [...user.accountControlRightsOverride] : [],
    temporaryAccess: Array.isArray(user.temporaryAccess) ? user.temporaryAccess.map((entry) => ({ ...entry })) : [],
    sections: Array.isArray(user.sections) ? [...user.sections] : [],
    assignedSections: Array.isArray(user.assignedSections) ? [...user.assignedSections] : [],
    coverageAreas: Array.isArray(user.coverageAreas) ? [...user.coverageAreas] : [],
    emailHistory: Array.isArray(user.emailHistory) ? user.emailHistory.map((entry) => ({ ...entry })) : [],
  };
}

function seedUsers() {
  const founder = {
    _id: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    name: 'Founder',
    role: 'founder',
    staffId: 'NP-FND-0001',
    accountStatus: 'active',
    noExpiry: true,
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
    name: 'Shailesh Rathod',
    fullName: 'Shailesh Rathod',
    role: 'editor',
    staffId: 'NP-2026-0003',
    position: 'Editorial Head',
    designation: 'Editorial Head',
    accountGroup: 'Staff Account / Newsroom Staff',
    department: 'Editorial / Newsroom',
    permissions: [],
    moduleAccessOverride: ['add_news'],
    moduleAccessStates: { addNews: 'enabled' },
    specialRightsOverride: ['news_create'],
    taskRightsOverride: [],
    accountControlRightsOverride: [],
    temporaryAccess: [],
    status: 'active',
    accountStatus: 'active',
    noExpiry: false,
    mustChangePassword: false,
    mustResetPassword: false,
    forceReset: false,
    accessVersion: 0,
    tokenVersion: 0,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    lastLoginAt: null,
  };
  const manager = {
    _id: '507f1f77bcf86cd799439013',
    email: 'manager@example.com',
    name: 'Delegated Manager',
    role: 'manager',
    staffId: 'NP-2026-0004',
    position: 'Manager',
    accountGroup: 'Management Staff',
    department: 'Management & Operations',
    permissions: [],
    status: 'active',
    accountStatus: 'active',
    noExpiry: true,
    mustChangePassword: false,
    mustResetPassword: false,
    forceReset: false,
    tokenVersion: 0,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    lastLoginAt: null,
  };
  usersById = new Map([
    [founder._id, founder],
    [editor._id, editor],
    [manager._id, manager],
  ]);
  usersByEmail = new Map([
    [founder.email, founder._id],
    [editor.email, editor._id],
    [manager.email, manager._id],
  ]);
  delegationsById = new Map();
  auditLogs = [];
  otpTokenUpdates = [];
  sessionUpdates = [];
  siteSettingsDoc = {
    _id: '507f1f77bcf86cd799439555',
    adminModulePolicy: {
      version: 3,
      modulePolicies: CANONICAL_ADMIN_MODULE_KEYS.reduce((acc, key) => {
        acc[key] = key === 'safeZone' ? 'founder_only' : 'available';
        return acc;
      }, {}),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedBy: 'test-founder@example.com',
      auditReason: 'test policy',
    },
  };
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

function makeDocQuery(doc, clone = (value) => value) {
  return {
    lean: async () => clone(doc),
    select: async () => clone(doc),
    then(resolve, reject) {
      return Promise.resolve(clone(doc)).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(clone(doc)).catch(reject);
    },
  };
}

function matchesCondition(value, condition) {
  if (!condition || typeof condition !== 'object' || condition instanceof Date || Array.isArray(condition)) return value === condition;
  if (Object.prototype.hasOwnProperty.call(condition, '$ne') && value === condition.$ne) return false;
  if (Object.prototype.hasOwnProperty.call(condition, '$nin') && condition.$nin.includes(value)) return false;
  if (Object.prototype.hasOwnProperty.call(condition, '$in')) {
    const normalized = value === undefined ? undefined : value;
    return condition.$in.some((item) => item === normalized || (item === null && normalized === null));
  }
  if (Object.prototype.hasOwnProperty.call(condition, '$exists')) {
    const exists = value !== undefined;
    if (Boolean(condition.$exists) !== exists) return false;
  }
  return true;
}

function valueAtPath(obj, path) {
  return String(path || '').split('.').reduce((current, key) => (current == null ? undefined : current[key]), obj);
}

function matchesQuery(user, query) {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$and) && !query.$and.every((item) => matchesQuery(user, item))) return false;
  if (Array.isArray(query.$or) && !query.$or.some((item) => matchesQuery(user, item))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and' || key === '$or') continue;
    if (!matchesCondition(valueAtPath(user, key), condition)) return false;
  }
  return true;
}

User.findById = async (id) => cloneUser(usersById.get(String(id)));
User.findOne = (filter) => {
  let user = null;
  if (filter && filter.email) {
    const id = usersByEmail.get(String(filter.email || '').toLowerCase());
    user = id ? usersById.get(id) : null;
  } else if (filter && filter.staffId) {
    const staffId = String(filter.staffId || '').trim().toUpperCase();
    user = Array.from(usersById.values()).find((item) => String(item.staffId || '').trim().toUpperCase() === staffId) || null;
  }
  return makeDocQuery(user, cloneUser);
};
User.find = (query) => makeFindChain(Array.from(usersById.values()).filter((user) => matchesQuery(user, query)));
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
  const setPatch = update && update.$set ? update.$set : {};
  const incPatch = update && update.$inc ? Object.entries(update.$inc).reduce((acc, [key, value]) => {
    acc[key] = (typeof current[key] === 'number' ? current[key] : 0) + value;
    return acc;
  }, {}) : {};
  const next = {
    ...current,
    ...setPatch,
    ...incPatch,
  };
  if (update && update.$push) {
    for (const [key, value] of Object.entries(update.$push)) {
      next[key] = [...(Array.isArray(current[key]) ? current[key] : []), value];
    }
  }
  usersById.set(String(id), next);
  if (setPatch.email && current.email && String(current.email).toLowerCase() !== String(setPatch.email).toLowerCase()) {
    usersByEmail.delete(String(current.email).toLowerCase());
  }
  if (next.email) usersByEmail.set(String(next.email).toLowerCase(), String(id));
  return cloneUser(next);
};

SiteSettings.findOne = async () => siteSettingsDoc;
SiteSettings.create = async (payload) => {
  siteSettingsDoc = { _id: '507f1f77bcf86cd799439555', ...payload };
  return siteSettingsDoc;
};
SiteSettings.findOneAndUpdate = async (filter, update) => {
  siteSettingsDoc = { ...siteSettingsDoc, ...(update && update.$set ? update.$set : {}) };
  return siteSettingsDoc;
};
User.deleteOne = async (filter) => {
  const id = String(filter && filter._id || '');
  const current = usersById.get(id);
  if (!current) return { deletedCount: 0 };
  usersById.delete(id);
  if (current.email) usersByEmail.delete(String(current.email).toLowerCase());
  return { deletedCount: 1 };
};

Role.findById = () => ({ lean: async () => null });
Role.findOne = () => ({ lean: async () => null });

Counter.findOneAndUpdate = async (filter) => {
  const key = String(filter?.key || 'staffId_2026');
  const existingSequences = Array.from(usersById.values())
    .map((user) => String(user.staffId || '').match(/^NP-(\d{4})-(\d{4})$/))
    .filter((match) => match && `staffId_${match[1]}` === key)
    .map((match) => Number(match[2]));
  return { key, value: Math.max(0, ...existingSequences) + 1 };
};
Counter.findOne = async (filter) => {
  const key = String(filter?.key || 'staffId_2026');
  const existingSequences = Array.from(usersById.values())
    .map((user) => String(user.staffId || '').match(/^NP-(\d{4})-(\d{4})$/))
    .filter((match) => match && `staffId_${match[1]}` === key)
    .map((match) => Number(match[2]));
  return { key, value: Math.max(0, ...existingSequences) };
};

AuditLog.create = async (payload) => {
  auditLogs.push(payload);
  return { ok: true };
};
AuditLog.countDocuments = async (filter) => auditLogs.filter((entry) => {
  if (!filter || !filter.key || entry.key !== filter.key) return false;
  if (!filter.action || !filter.action.$regex) return true;
  return filter.action.$regex.test(String(entry.action || ''));
}).length;
News.countDocuments = async () => 0;
FinanceRecord.countDocuments = async () => 0;
OtpToken.updateMany = async (filter, update) => {
  otpTokenUpdates.push({ filter, update });
  return { modifiedCount: 1 };
};
SessionLog.updateMany = async (filter, update) => {
  sessionUpdates.push({ filter, update });
  return { modifiedCount: 1 };
};

function cloneDelegation(delegation) {
  return delegation ? {
    ...delegation,
    grantedRights: Array.isArray(delegation.grantedRights) ? [...delegation.grantedRights] : [],
    manageableAccountTypes: Array.isArray(delegation.manageableAccountTypes) ? [...delegation.manageableAccountTypes] : [],
  } : null;
}

function makeDelegationFindChain(delegations) {
  return {
    lean: async () => delegations.map(cloneDelegation),
    sort() {
      return { lean: async () => delegations.map(cloneDelegation) };
    },
  };
}

function matchesDelegationQuery(delegation, query) {
  if (!query || !Object.keys(query).length) return true;
  for (const [key, value] of Object.entries(query)) {
    if (delegation[key] !== value) return false;
  }
  return true;
}

AccountControlDelegation.find = (query) => makeDelegationFindChain(Array.from(delegationsById.values()).filter((delegation) => matchesDelegationQuery(delegation, query)));
AccountControlDelegation.create = async (payload) => {
  const _id = `507f1f77bcf86cd7994391${String(delegationsById.size).padStart(2, '0')}`;
  const now = new Date();
  const created = { _id, createdAt: now, updatedAt: now, ...payload };
  delegationsById.set(_id, created);
  return cloneDelegation(created);
};
AccountControlDelegation.findById = (id) => makeDocQuery(delegationsById.get(String(id)) || null, cloneDelegation);
AccountControlDelegation.findByIdAndUpdate = async (id, update) => {
  const current = delegationsById.get(String(id));
  if (!current) return null;
  const next = { ...current, ...(update && update.$set ? update.$set : {}), updatedAt: new Date() };
  delegationsById.set(String(id), next);
  return cloneDelegation(next);
};

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
  originalConnectionDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = { collection: () => ({}) };
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
  mongoose.connection.db = originalConnectionDb;
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

  assert.equal(res.status, 200, JSON.stringify(res.body));
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

test('Staff Access save accepts canonical keys, aliases, object draft values, and returns effective access', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const res = await request(app)
    .patch('/api/admin/access/staff/NP-2026-0003/modules')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      auditReason: 'Founder saved Staff Access changes',
      moduleAccessStates: {
        'DPDP Privacy Requests': { individualState: 'Enabled' },
        ads_manager: { individualState: 'Enabled' },
        settings: 'enabled',
        'AI Engine': { state: 'Enabled' },
        dashboard: true,
        live_tv: false,
      },
    });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.record.accessVersion, 1);
  assert.deepEqual(res.body.data.record.moduleAccessStates, {
    dpdpCompliance: 'enabled',
    adsManager: 'enabled',
    settings: 'enabled',
    aiEngine: 'enabled',
    dashboard: 'enabled',
    liveTv: 'disabled',
  });
  assert.deepEqual(res.body.data.record.moduleAccessOverride, ['dpdp_compliance', 'ads_manager', 'settings', 'ai_engine', 'dashboard']);
  assert.equal(res.body.data.effectiveAccess.accessVersion, 1);
  assert.equal(res.body.data.effectiveAccess.policyVersion, 3);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.dpdpCompliance.allowed, true);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.adsManager.allowed, true);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.settings.allowed, true);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.aiEngine.allowed, true);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.liveTv.reasonCode, 'STAFF_ACCESS_DISABLED');
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439012').moduleAccessStates, res.body.data.record.moduleAccessStates);
  assert.ok(auditLogs.some((entry) => entry.action === 'TEAM_ACCESS_CHANGE' && entry.reason === 'Founder saved Staff Access changes'));
});

test('Staff Access save rejects malformed payloads with precise errors and no partial save', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const before = cloneUser(usersById.get('507f1f77bcf86cd799439012'));

  const res = await request(app)
    .patch('/api/admin/access/staff/NP-2026-0003/modules')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      auditReason: 'bad payload should not save',
      moduleAccess: {
        dpdpCompliance: 'enabled',
        unknownPanel: 'enabled',
      },
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_MODULE_ACCESS_PAYLOAD');
  assert.equal(res.body.invalidField, 'moduleAccess.unknownPanel');
  assert.equal(res.body.reason, 'UNKNOWN_MODULE_KEY');
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439012').moduleAccessOverride, before.moduleAccessOverride);
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439012').moduleAccessStates, before.moduleAccessStates);
  assert.equal(usersById.get('507f1f77bcf86cd799439012').accessVersion, before.accessVersion);
  assert.equal(auditLogs.some((entry) => entry.action === 'TEAM_ACCESS_CHANGE'), false);
});

test('Staff Access save blocks Safe Zone grants while accepting a full canonical module map', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const fullMap = CANONICAL_ADMIN_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = key === 'safeZone' ? 'disabled' : 'enabled';
    return acc;
  }, { dashboard: 'enabled' });

  const safeZoneGrant = await request(app)
    .patch('/api/admin/access/staff/NP-2026-0003/modules')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'try safe zone grant', moduleAccessStates: { safeZone: 'enabled' } });

  assert.equal(safeZoneGrant.status, 400);
  assert.equal(safeZoneGrant.body.code, 'INVALID_MODULE_ACCESS_PAYLOAD');
  assert.equal(safeZoneGrant.body.reason, 'FOUNDER_ONLY_MODULE');

  const fullSave = await request(app)
    .patch('/api/admin/access/staff/NP-2026-0003/modules')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'save full access map', moduleAccessStates: fullMap });

  assert.equal(fullSave.status, 200, JSON.stringify(fullSave.body));
  assert.equal(fullSave.body.data.record.moduleAccessStates.dpdpCompliance, 'enabled');
  assert.equal(fullSave.body.data.record.moduleAccessStates.settings, 'enabled');
  assert.equal(fullSave.body.data.record.moduleAccessStates.aiEngine, 'enabled');
  assert.equal(fullSave.body.data.record.moduleAccessStates.safeZone, 'disabled');
  assert.equal(fullSave.body.data.effectiveAccess.canonicalModules.safeZone.allowed, false);
  assert.equal(fullSave.body.data.effectiveAccess.canonicalModules.safeZone.reasonCode, 'FOUNDER_ONLY');
});

test('Temporary module access accepts canonical aliases and returns allowed effective access', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const res = await request(app)
    .post('/api/admin/access/staff/507f1f77bcf86cd799439012/temporary')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      auditReason: 'temporary DPDP access',
      moduleKey: 'DPDP Privacy Requests',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.effectiveAccess.canonicalModules.dpdpCompliance.allowed, true);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.dpdpCompliance.individualState, 'temporary');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').temporaryAccess[0].moduleKey, 'dpdp_compliance');
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
  assert.equal(res.body.data.user.staffId, 'NP-2026-0005');
  assert.equal(res.body.data.user.staffIdLocked, true);
});

test('POST /api/admin/team/users accepts frontend payload aliases and ignores staff ID display text', async () => {
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
    .send({
      fullName: 'Alias Staff',
      loginId: 'alias-staff@example.com',
      role: 'reporter',
      accountStatus: 'active',
      accessExpiryDate: '2026-12-31T00:00:00.000Z',
      assignedSections: ['Gujarat'],
      coverageAreas: ['All Gujarat'],
      staffId: 'Next New Staff ID: NP-2026-0001',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.email, 'alias-staff@example.com');
  assert.equal(res.body.data.user.staffId, 'NP-2026-0005');
  assert.equal(res.body.data.user.accountStatus, 'active');
  assert.equal(usersById.get('507f1f77bcf86cd799439099').staffId, 'NP-2026-0005');
});

test('POST /api/admin/team/users returns useful array validation errors', async () => {
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
    .send({
      fullName: 'Bad Sections',
      email: 'bad-sections@example.com',
      role: 'reporter',
      assignedSections: 'Gujarat',
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_ASSIGNED_SECTIONS');
  assert.equal(res.body.message, 'assignedSections must be an array');
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

test('founder uses NP-FND-0001 and next staff ID preview matches generated sequence', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const listRes = await request(app)
    .get('/api/team/users')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(listRes.status, 200);
  const founder = listRes.body.users.find((user) => user.email === 'newspulse.team@gmail.com');
  assert.equal(founder.staffId, 'NP-FND-0001');

  const previewBefore = await request(app)
    .get('/api/team/next-staff-id')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(previewBefore.status, 200);
  assert.match(previewBefore.body.nextStaffId, /^NP-2026-\d{4}$/);

  const firstCreate = await request(app)
    .post('/api/team/create-user')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'First Staff', email: 'first-staff@example.com', role: 'reporter' });

  assert.equal(firstCreate.status, 201);
  assert.equal(firstCreate.body.data.user.staffId, previewBefore.body.nextStaffId);

  const previewAfter = await request(app)
    .get('/api/team/next-staff-id')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(previewAfter.status, 200);
  const beforeSequence = Number(previewBefore.body.nextStaffId.slice(-4));
  const afterSequence = Number(previewAfter.body.nextStaffId.slice(-4));
  assert.equal(afterSequence, beforeSequence + 1);
});

test('staff ID remains immutable after creation even when role changes', async () => {
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
    .send({ fullName: 'Role Changer', email: 'role-change@example.com', role: 'reporter' });

  assert.equal(createRes.status, 201);
  const userId = createRes.body.data.user.id;
  const originalStaffId = createRes.body.data.user.staffId;
  assert.equal(originalStaffId, 'NP-2026-0005');

  const roleUpdate = await request(app)
    .patch(`/api/team/users/${userId}`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ role: 'editor' });

  assert.equal(roleUpdate.status, 200);
  assert.equal(roleUpdate.body.data.user.role, 'editor');
  assert.equal(roleUpdate.body.data.user.staffId, originalStaffId);

  const blockedStaffIdUpdate = await request(app)
    .patch(`/api/team/users/${userId}`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ staffId: 'NP-2026-9999' });

  assert.equal(blockedStaffIdUpdate.status, 400);
  assert.equal(blockedStaffIdUpdate.body.code, 'STAFF_ID_IMMUTABLE');
  assert.equal(usersById.get(userId).staffId, originalStaffId);
});

test('PATCH /api/admin/team/users/:id/email changes login email while preserving Staff ID and revoking access', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  usersById.get('507f1f77bcf86cd799439012').staffId = 'NP-2026-0007';
  usersById.get('507f1f77bcf86cd799439012').staffIdLocked = true;
  const originalStaffId = usersById.get('507f1f77bcf86cd799439012').staffId;
  const res = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439012/email')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      newEmail: '  Editor.Official@NewsPulse.Co.In  ',
      reason: 'Staff moved to official News Pulse email',
      forcePasswordChange: true,
      logoutAllDevices: true,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.user.email, 'editor.official@newspulse.co.in');
  assert.equal(res.body.user.staffId, originalStaffId);
  assert.equal(res.body.user.mustChangePassword, true);

  const updated = usersById.get('507f1f77bcf86cd799439012');
  assert.equal(updated.staffId, originalStaffId);
  assert.equal(updated.role, 'editor');
  assert.equal(updated.email, 'editor.official@newspulse.co.in');
  assert.equal(updated.mustChangePassword, true);
  assert.equal(updated.mustResetPassword, true);
  assert.equal(updated.forceReset, true);
  assert.equal(updated.tokenVersion, 1);
  assert.equal(usersByEmail.has('editor@example.com'), false);
  assert.equal(usersByEmail.get('editor.official@newspulse.co.in'), '507f1f77bcf86cd799439012');
  assert.equal(updated.emailHistory.length, 1);
  assert.equal(updated.emailHistory[0].oldEmail, 'editor@example.com');
  assert.equal(updated.emailHistory[0].newEmail, 'editor.official@newspulse.co.in');

  assert.equal(otpTokenUpdates.length, 1);
  assert.equal(otpTokenUpdates[0].filter.email, 'editor@example.com');
  assert.equal(otpTokenUpdates[0].update.$set.used, true);
  assert.equal(sessionUpdates.length, 1);
  assert.equal(String(sessionUpdates[0].filter.userId), '507f1f77bcf86cd799439012');
  assert.equal(sessionUpdates[0].update.$set.status, 'ended');
  assert.equal(sessionUpdates[0].update.$set.logoutReason, 'staff_email_changed');
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_EMAIL_CHANGED'));
});

test('staff email endpoint blocks founder email changes, duplicate emails, and shared system mailboxes', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const founderChange = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439011/email')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ newEmail: 'founder-new@example.com', reason: 'normal edit attempt' });

  assert.equal(founderChange.status, 403);
  assert.equal(founderChange.body.code, 'FOUNDER_PROTECTED');
  assert.equal(founderChange.body.message, 'Founder account is protected. Use Founder My Account / Safe Zone.');

  const duplicate = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439012/email')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ newEmail: 'newspulse.team@gmail.com', reason: 'duplicate check' });

  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.code, 'SHARED_SYSTEM_EMAIL_BLOCKED');

  usersById.set('507f1f77bcf86cd799439013', {
    _id: '507f1f77bcf86cd799439013',
    email: 'duplicate@example.com',
    name: 'Duplicate',
    role: 'reporter',
    permissions: [],
    status: 'active',
    tokenVersion: 0,
  });
  usersByEmail.set('duplicate@example.com', '507f1f77bcf86cd799439013');

  const duplicateNonSystem = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439012/email')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ newEmail: 'duplicate@example.com', reason: 'duplicate check' });

  assert.equal(duplicateNonSystem.status, 409);
  assert.equal(duplicateNonSystem.body.code, 'EMAIL_EXISTS');
  assert.ok(auditLogs.some((entry) => entry.action === 'BLOCKED_FOUNDER_STAFF_ACTION'));
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_EMAIL_CHANGE_DUPLICATE'));
});

test('admin needs staff email change permission and staff cannot self-change login email', async () => {
  const app = buildApp();

  const editorToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'editor',
    name: 'Editor',
  });

  const selfChange = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439012/email')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ newEmail: 'self-change@example.com', reason: 'self change' });

  assert.equal(selfChange.status, 403);
  assert.equal(selfChange.body.code, 'FORBIDDEN');

  usersById.get('507f1f77bcf86cd799439012').role = 'admin';
  usersById.get('507f1f77bcf86cd799439012').permissions = ['auth.change_staff_email'];
  const delegatedAdminToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'admin',
    name: 'Editor Admin',
  });

  const delegatedChange = await request(app)
    .patch('/api/admin/team/users/507f1f77bcf86cd799439012/email')
    .set('Authorization', `Bearer ${delegatedAdminToken}`)
    .send({ newEmail: 'delegated-admin@example.com', reason: 'Founder granted staff_email_change' });

  assert.equal(delegatedChange.status, 200);
  assert.equal(delegatedChange.body.user.email, 'delegated-admin@example.com');
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

test('temporary password and force-change endpoints never expose password hashes', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const tempRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/generate-temporary-password')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(tempRes.status, 200);
  assert.equal(typeof tempRes.body.temporaryPassword, 'string');
  assert.equal(typeof tempRes.body.user.passwordHash, 'undefined');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').mustChangePassword, true);
  assert.equal(usersById.get('507f1f77bcf86cd799439012').tokenVersion, 1);
  assert.equal(sessionUpdates[0].update.$set.logoutReason, 'staff_temp_password_generated');
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_TEMP_PASSWORD_GENERATED'));

  const forceRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/force-change-password')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ logoutAllDevices: true });

  assert.equal(forceRes.status, 200);
  assert.equal(forceRes.body.message, 'Password change already required.');
  assert.equal(typeof forceRes.body.user.passwordHash, 'undefined');
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_FORCE_CHANGE_PASSWORD'));
});

test('extend, archive, reactivate, and logout-all-devices update status safely', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const editor = usersById.get('507f1f77bcf86cd799439012');
  editor.status = 'expired';
  editor.accountStatus = 'expired';
  editor.accessExpiresAt = new Date('2026-01-01T00:00:00.000Z');

  const extendRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/extend-access')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ accessExpiryDate: '2026-12-31T00:00:00.000Z' });

  assert.equal(extendRes.status, 200, JSON.stringify(extendRes.body));
  assert.equal(extendRes.body.user.accountStatus, 'active');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').loginAllowed, true);
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_ACCESS_EXTENDED'));

  const archiveRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/archive')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ reason: 'left organization' });

  assert.equal(archiveRes.status, 200);
  assert.equal(archiveRes.body.user.accountStatus, 'archived');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').loginAllowed, false);
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_ARCHIVED'));
  assert.equal(usersById.has('507f1f77bcf86cd799439012'), true);

  const reactivateRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/reactivate')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ accessExpiryDate: '2027-01-31T00:00:00.000Z' });

  assert.equal(reactivateRes.status, 200);
  assert.equal(reactivateRes.body.user.accountStatus, 'active');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').loginAllowed, true);
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_REACTIVATED'));

  const logoutRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/logout-all-devices')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(logoutRes.status, 200);
  assert.equal(sessionUpdates.at(-1).update.$set.logoutReason, 'staff_logout_all_devices');
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_LOGOUT_ALL_DEVICES'));
});

test('expired staff is denied before module access but remains visible in Staff Registry', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const expiredToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'editor',
    name: 'Shailesh Rathod',
  });
  const editor = usersById.get('507f1f77bcf86cd799439012');
  editor.status = 'active';
  editor.accountStatus = 'active';
  editor.accessExpiresAt = new Date('2026-01-01T00:00:00.000Z');
  editor.noExpiry = false;
  editor.moduleAccessOverride = ['staff_tasks', 'add_news'];

  const taskRes = await request(app)
    .get('/api/admin/team/tasks')
    .set('Authorization', `Bearer ${expiredToken}`);

  assert.equal(taskRes.status, 403);
  assert.equal(taskRes.body.code, 'ACCOUNT_EXPIRED');
  assert.equal(taskRes.body.message, 'Your staff account access period has expired.');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').accountStatus, 'expired');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').staffId, 'NP-2026-0003');

  const listRes = await request(app)
    .get('/api/admin/team/staff')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(listRes.status, 200);
  const listed = listRes.body.users.find((user) => user.staffId === 'NP-2026-0003');
  assert.ok(listed);
  assert.equal(listed.accountStatus, 'expired');
});

test('Shailesh NP-2026-0003 reactivates to no-expiry active without losing access settings', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const editor = usersById.get('507f1f77bcf86cd799439012');
  editor.status = 'expired';
  editor.accountStatus = 'expired';
  editor.loginAllowed = false;
  editor.accessExpiresAt = new Date('2026-01-01T00:00:00.000Z');
  editor.noExpiry = false;
  editor.moduleAccessOverride = ['add_news', 'manage_news'];
  editor.specialRightsOverride = ['news_create', 'news_edit'];

  const res = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/reactivate')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ noExpiry: true, auditReason: 'Founder reactivated Editorial Head as permanent staff' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.staffId, 'NP-2026-0003');
  assert.equal(res.body.user.accountStatus, 'active');
  assert.equal(res.body.user.noExpiry, true);
  assert.equal(res.body.user.accessExpiresAt, null);
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439012').moduleAccessOverride, ['add_news', 'manage_news']);
  assert.deepEqual(usersById.get('507f1f77bcf86cd799439012').specialRightsOverride, ['news_create', 'news_edit']);
  assert.ok(auditLogs.some((entry) => entry.action === 'ACCOUNT_REACTIVATED'));
});

test('extend access and password reset preserve existing Staff ID', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const extendRes = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/extend-access')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ expiryPreset: '90_days', auditReason: 'extend editorial access' });

  assert.equal(extendRes.status, 200, JSON.stringify(extendRes.body));
  assert.equal(extendRes.body.user.staffId, 'NP-2026-0003');
  assert.equal(extendRes.body.user.noExpiry, false);

  const resetRes = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/reset-password')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'force password reset' });

  assert.equal(resetRes.status, 200, JSON.stringify(resetRes.body));
  assert.equal(resetRes.body.user.staffId, 'NP-2026-0003');
  assert.equal(usersById.get('507f1f77bcf86cd799439012').staffId, 'NP-2026-0003');
  assert.equal(JSON.stringify(auditLogs).includes(resetRes.body.temporaryPassword), false);
  assert.equal(JSON.stringify(auditLogs).includes('passwordHash'), false);
});

test('Founder account is no-expiry and cannot be suspended archived or deleted', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const founder = usersById.get('507f1f77bcf86cd799439011');
  founder.accessExpiresAt = new Date('2020-01-01T00:00:00.000Z');
  founder.noExpiry = true;

  const stateRes = await request(app)
    .get('/api/admin/team/staff/507f1f77bcf86cd799439011/account-control')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.body.accountState.accountStatus, 'active');
  assert.equal(stateRes.body.accountState.noExpiry, true);

  const archiveRes = await request(app)
    .post('/api/admin/team/staff/507f1f77bcf86cd799439011/archive')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(archiveRes.status, 403);
  assert.equal(archiveRes.body.code, 'FOUNDER_PROTECTED');

  const deleteRes = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439011/delete-permanently')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'DELETE', reason: 'never' });

  assert.equal(deleteRes.status, 403);
  assert.equal(deleteRes.body.code, 'FOUNDER_PROTECTED');
  assert.equal(usersById.get('507f1f77bcf86cd799439011').staffId, 'NP-FND-0001');
});

test('delegated user with extend right can extend eligible staff only', async () => {
  const app = buildApp();
  delegationsById.set('507f1f77bcf86cd799439100', {
    _id: '507f1f77bcf86cd799439100',
    delegatedToStaffId: 'NP-2026-0004',
    grantedRights: ['extend_account_expiry'],
    manageableAccountTypes: ['newsroom_staff'],
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    active: true,
    appointedByFounderId: 'NP-FND-0001',
    auditReason: 'trusted manager',
  });
  const managerToken = signToken({
    sub: '507f1f77bcf86cd799439013',
    email: 'manager@example.com',
    role: 'manager',
    name: 'Delegated Manager',
  });

  const res = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/extend-access')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ expiryPreset: '30_days', auditReason: 'delegated extension' });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.staffId, 'NP-2026-0003');
  assert.ok(auditLogs.some((entry) => entry.action === 'ACCOUNT_EXPIRY_EXTENDED'));

  const founderRes = await request(app)
    .post('/api/admin/team/staff/NP-FND-0001/extend-access')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ expiryPreset: '30_days' });

  assert.equal(founderRes.status, 403);
  assert.equal(founderRes.body.code, 'FOUNDER_PROTECTED');
});

test('delegated user without right or with expired delegation receives 403 and cannot self-grant', async () => {
  const app = buildApp();
  delegationsById.set('507f1f77bcf86cd799439101', {
    _id: '507f1f77bcf86cd799439101',
    delegatedToStaffId: 'NP-2026-0004',
    grantedRights: ['extend_account_expiry'],
    manageableAccountTypes: ['newsroom_staff'],
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    active: true,
    appointedByFounderId: 'NP-FND-0001',
  });
  const managerToken = signToken({
    sub: '507f1f77bcf86cd799439013',
    email: 'manager@example.com',
    role: 'manager',
    name: 'Delegated Manager',
  });

  const expiredDelegationRes = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/extend-access')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ expiryPreset: '30_days' });

  assert.equal(expiredDelegationRes.status, 403, JSON.stringify(expiredDelegationRes.body));

  const missingRightRes = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/suspend')
    .set('Authorization', `Bearer ${managerToken}`);

  assert.equal(missingRightRes.status, 403);

  const selfGrantRes = await request(app)
    .post('/api/admin/team/delegations')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ delegatedToStaffId: 'NP-2026-0004', grantedRights: ['suspend_staff_account'], manageableAccountTypes: ['newsroom_staff'], auditReason: 'self grant' });

  assert.equal(selfGrantRes.status, 403);
});

test('Founder grants updates and revokes delegation with audit and token invalidation', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const grantRes = await request(app)
    .post('/api/admin/team/delegations')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ delegatedToStaffId: 'NP-2026-0004', grantedRights: ['extend_account_expiry'], manageableAccountTypes: ['newsroom_staff'], auditReason: 'trusted account control' });

  assert.equal(grantRes.status, 201);
  assert.equal(grantRes.body.delegation.delegatedToStaffId, 'NP-2026-0004');
  assert.ok(auditLogs.some((entry) => entry.action === 'DELEGATION_GRANTED'));

  const updateRes = await request(app)
    .patch(`/api/admin/team/delegations/${grantRes.body.delegation.id}`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ grantedRights: ['extend_account_expiry', 'lock_staff_account'], auditReason: 'add lock right' });

  assert.equal(updateRes.status, 200);
  assert.deepEqual(updateRes.body.delegation.grantedRights, ['extend_account_expiry', 'lock_staff_account']);

  const beforeTokenVersion = usersById.get('507f1f77bcf86cd799439013').tokenVersion;
  const revokeRes = await request(app)
    .delete(`/api/admin/team/delegations/${grantRes.body.delegation.id}`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'remove delegated access' });

  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.body.delegation.active, false);
  assert.equal(usersById.get('507f1f77bcf86cd799439013').tokenVersion, beforeTokenVersion + 1);
  assert.ok(auditLogs.some((entry) => entry.action === 'DELEGATION_REVOKED'));
});

test('role change does not change Staff ID and database unavailable is not false success', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const roleRes = await request(app)
    .patch('/api/admin/team/staff/507f1f77bcf86cd799439012')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ role: 'manager' });

  assert.equal(roleRes.status, 200);
  assert.equal(roleRes.body.user.staffId, 'NP-2026-0003');

  mongoose.connection.readyState = 0;
  const dbDownRes = await request(app)
    .post('/api/admin/team/staff/NP-2026-0003/reactivate')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ noExpiry: true });

  assert.equal(dbDownRes.status, 503);
  assert.equal(dbDownRes.body.code, 'DB_UNAVAILABLE');
});

test('mark-test-account flags non-founder test accounts and blocks founder', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const blockedFounder = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439011/mark-test-account')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ reason: 'never allowed' });

  assert.equal(blockedFounder.status, 403);
  assert.equal(blockedFounder.body.code, 'FOUNDER_PROTECTED');

  const marked = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439012/mark-test-account')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ reason: 'old unwanted test record' });

  assert.equal(marked.status, 200);
  assert.equal(marked.body.user.isTestAccount, true);
  assert.equal(usersById.get('507f1f77bcf86cd799439012').isTestAccount, true);
  assert.equal(usersById.get('507f1f77bcf86cd799439012').testAccountReason, 'old unwanted test record');
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_MARKED_TEST'));
});

test('staff list hides archived deleted and test accounts unless include flags are set', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  usersById.set('507f1f77bcf86cd799439020', {
    _id: '507f1f77bcf86cd799439020',
    email: 'archived@example.com',
    name: 'Archived Staff',
    role: 'reporter',
    permissions: [],
    status: 'archived',
    accountStatus: 'archived',
    isArchived: true,
    tokenVersion: 0,
  });
  usersById.set('507f1f77bcf86cd799439021', {
    _id: '507f1f77bcf86cd799439021',
    email: 'deleted@example.com',
    name: 'Deleted Test Staff',
    role: 'reporter',
    permissions: [],
    status: 'deleted',
    accountStatus: 'deleted',
    deletedAt: new Date('2026-06-01T00:00:00.000Z'),
    tokenVersion: 0,
  });
  usersById.set('507f1f77bcf86cd799439022', {
    _id: '507f1f77bcf86cd799439022',
    email: 'test-visible@example.com',
    name: 'Test Editor',
    role: 'editor',
    permissions: [],
    status: 'active',
    accountStatus: 'active',
    isTestAccount: true,
    tokenVersion: 0,
  });

  const defaultList = await request(app)
    .get('/api/admin/team/users')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(defaultList.status, 200);
  assert.equal(defaultList.body.users.some((user) => user.email === 'archived@example.com'), false);
  assert.equal(defaultList.body.users.some((user) => user.email === 'deleted@example.com'), false);
  assert.equal(defaultList.body.users.some((user) => user.email === 'test-visible@example.com'), false);

  const includeList = await request(app)
    .get('/api/admin/team/users?includeArchived=true&includeDeleted=true&includeTest=true')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(includeList.status, 200);
  assert.equal(includeList.body.users.some((user) => user.email === 'archived@example.com'), true);
  assert.equal(includeList.body.users.some((user) => user.email === 'deleted@example.com'), true);
  assert.equal(includeList.body.users.some((user) => user.email === 'test-visible@example.com'), true);
});

test('test-only delete rejects real staff and deletes only safe confirmed test accounts', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });

  const realDelete = await request(app)
    .delete('/api/admin/team/users/507f1f77bcf86cd799439012/test-only')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ founderConfirmation: 'DELETE_TEST_ACCOUNT' });

  assert.equal(realDelete.status, 400);
  assert.equal(realDelete.body.code, 'TEST_DELETE_BLOCKED');
  assert.equal(realDelete.body.message, 'Real staff accounts cannot be deleted. Archive account instead.');
  assert.equal(usersById.has('507f1f77bcf86cd799439012'), true);

  const testId = '507f1f77bcf86cd799439088';
  usersById.set(testId, {
    _id: testId,
    email: 'delete.test@example.com',
    name: 'Delete TEST Account',
    role: 'reporter',
    designation: 'TEST Reporter',
    permissions: [],
    status: 'active',
    accountStatus: 'active',
    tokenVersion: 0,
    canBeDeleted: true,
  });
  usersByEmail.set('delete.test@example.com', testId);

  const missingConfirmation = await request(app)
    .delete(`/api/admin/team/users/${testId}/test-only`)
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.body.code, 'MISSING_FOUNDER_CONFIRMATION');
  assert.equal(usersById.has(testId), true);

  const deleteRes = await request(app)
    .delete(`/api/admin/team/users/${testId}/test-only`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ founderConfirmation: 'DELETE_TEST_ACCOUNT' });

  assert.equal(deleteRes.status, 200);
  assert.equal(usersById.has(testId), true);
  assert.equal(usersById.get(testId).accountStatus, 'deleted');
  assert.ok(usersById.get(testId).deletedAt instanceof Date);
  assert.equal(usersByEmail.has('delete.test@example.com'), true);
  assert.ok(auditLogs.some((entry) => entry.action === 'STAFF_TEST_DELETED'));
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
  assert.equal(suspendRes.body.message, 'Founder account is protected. Use Founder My Account / Safe Zone.');

  const resetRes = await request(app)
    .post('/api/admin/team/users/507f1f77bcf86cd799439011/force-reset')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(resetRes.status, 403);
  assert.equal(resetRes.body.code, 'FOUNDER_PROTECTED');
  assert.equal(usersById.get('507f1f77bcf86cd799439011').staffId, 'NP-FND-0001');
  assert.equal(usersById.get('507f1f77bcf86cd799439011').role, 'founder');
  assert.ok(auditLogs.some((entry) => entry.action === 'BLOCKED_FOUNDER_STAFF_ACTION'));
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

test('Founder permanently deletes unwanted staff only after DELETE confirmation and burns Staff ID', async () => {
  const app = buildApp();
  const founderToken = signToken({
    sub: '507f1f77bcf86cd799439011',
    email: 'newspulse.team@gmail.com',
    role: 'founder',
    name: 'Founder',
  });
  const editorToken = signToken({
    sub: '507f1f77bcf86cd799439012',
    email: 'editor@example.com',
    role: 'editor',
    name: 'Editor',
  });

  const editor = usersById.get('507f1f77bcf86cd799439012');
  Object.assign(editor, {
    staffId: 'NP-2026-0001',
    staffIdLocked: true,
    isTestAccount: true,
    name: 'Duplicate Test Staff',
    fullName: 'Duplicate Test Staff',
    passwordHash: 'hash-that-must-not-enter-audit',
    resetToken: 'token-that-must-not-enter-audit',
  });

  const expiredSession = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439012/delete-permanently')
    .send({ confirmText: 'DELETE', reason: 'Testing duplicate account cleanup' });

  assert.equal(expiredSession.status, 401);
  assert.equal(expiredSession.body.message, 'Session expired. Please login again.');

  const nonFounderDelete = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439012/delete-permanently')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ confirmText: 'DELETE', reason: 'Testing duplicate account cleanup' });

  assert.equal(nonFounderDelete.status, 403);
  assert.equal(nonFounderDelete.body.message, 'Founder permission required.');
  assert.equal(usersById.has('507f1f77bcf86cd799439012'), true);

  const missingConfirmation = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439012/delete-permanently')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'delete', reason: 'Testing duplicate account cleanup' });

  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.body.message, 'Confirmation text and reason are required.');
  assert.equal(usersById.has('507f1f77bcf86cd799439012'), true);

  const founderDelete = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439011/delete-permanently')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'DELETE', reason: 'Never allowed' });

  assert.equal(founderDelete.status, 403);
  assert.equal(founderDelete.body.code, 'FOUNDER_PROTECTED');
  assert.equal(founderDelete.body.message, 'Founder account cannot be deleted.');
  assert.equal(usersById.get('507f1f77bcf86cd799439011').staffId, 'NP-FND-0001');
  assert.equal(usersById.get('507f1f77bcf86cd799439011').role, 'founder');

  const protectedEmailId = '507f1f77bcf86cd799439077';
  usersById.set(protectedEmailId, {
    _id: protectedEmailId,
    email: 'kiran@newspulse.co.in',
    name: 'Protected Founder Email',
    role: 'reporter',
    staffId: null,
    permissions: [],
    status: 'active',
    accountStatus: 'active',
    isTestAccount: true,
    tokenVersion: 0,
  });
  usersByEmail.set('kiran@newspulse.co.in', protectedEmailId);

  const protectedEmailDelete = await request(app)
    .delete(`/api/admin/team/staff/${protectedEmailId}/delete-permanently`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'DELETE', reason: 'Never allowed' });

  assert.equal(protectedEmailDelete.status, 403);
  assert.equal(protectedEmailDelete.body.code, 'FOUNDER_PROTECTED');
  assert.equal(usersById.has(protectedEmailId), true);

  const missingStaff = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439066/delete-permanently')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'DELETE', reason: 'Testing duplicate account cleanup' });

  assert.equal(missingStaff.status, 404);
  assert.equal(missingStaff.body.message, 'Staff not found.');

  const deleteRes = await request(app)
    .delete('/api/admin/team/staff/507f1f77bcf86cd799439012/delete-permanently')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ confirmText: 'DELETE', reason: 'Testing duplicate account cleanup' });

  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.success, true);
  assert.equal(deleteRes.body.message, 'Staff account permanently deleted.');
  assert.equal(deleteRes.body.deletedStaffId, 'NP-2026-0001');
  assert.equal(usersById.has('507f1f77bcf86cd799439012'), false);
  assert.equal(usersByEmail.has('editor@example.com'), false);

  const defaultList = await request(app)
    .get('/api/admin/team/staff')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(defaultList.status, 200);
  assert.equal(defaultList.body.users.some((user) => user.staffId === 'NP-2026-0001'), false);

  const deleteAudit = auditLogs.find((entry) => entry.action === 'staff_deleted_permanently');
  assert.ok(deleteAudit);
  assert.equal(deleteAudit.actor.role, 'founder');
  assert.equal(deleteAudit.meta.targetStaffId, 'NP-2026-0001');
  assert.equal(deleteAudit.meta.targetEmail, 'editor@example.com');
  assert.equal(deleteAudit.reason, 'Testing duplicate account cleanup');
  assert.equal(deleteAudit.result, 'success');
  const auditJson = JSON.stringify(deleteAudit);
  assert.equal(auditJson.includes('hash-that-must-not-enter-audit'), false);
  assert.equal(auditJson.includes('token-that-must-not-enter-audit'), false);
  assert.equal(auditJson.includes('passwordHash'), false);
  assert.equal(auditJson.includes('resetToken'), false);

  const reuseDeletedStaffId = await request(app)
    .post('/api/admin/team/staff')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Reuse Deleted Staff ID', email: 'reuse-deleted@example.com', role: 'reporter', staffId: 'NP-2026-0001' });

  assert.equal(reuseDeletedStaffId.status, 409);
  assert.equal(reuseDeletedStaffId.body.code, 'STAFF_ID_RETIRED');

  const nextCreate = await request(app)
    .post('/api/admin/team/staff')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ fullName: 'Next Staff', email: 'next-staff@example.com', role: 'reporter' });

  assert.equal(nextCreate.status, 201);
  assert.equal(nextCreate.body.data.user.staffId, 'NP-2026-0005');
});
