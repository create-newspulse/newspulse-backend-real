require('./helpers/publicNewsIsolation');
process.env.JWT_SECRET = require('node:crypto').randomBytes(48).toString('hex');

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const {
  SPECIAL_RIGHT_KEYS,
  ROLE_DEFAULT_ACCESS,
  computeEffectiveAccess,
  effectiveModuleAccess,
  effectivePermissions,
  effectiveSpecialRights,
  hasAccountControlRight,
  hasPermission,
  hasSpecialRight,
  hasTaskRight,
  safeUserDto,
  specialRightsIdentityFields,
} = require('../lib/teamAccess');
const { evaluateAllModuleAccess, normalizeModulePolicies } = require('../services/founderAccessPolicyService');
const { hasRecordedNewsPublishGrant, GRANT_SOURCE } = require('../lib/newsPublishGrant');
const User = require('../models/User');
const Role = require('../models/Role');
const AuditLog = require('../models/AuditLog');
const Counter = require('../models/Counter');
const SiteSettings = require('../models/SiteSettings');
const { requireAuth, requireSpecialRight } = require('../middleware/requireAuth');
const { requireAdminAuth, requireFounderOnly } = require('../middleware/adminAuth');
const teamManagement = require('../lib/teamManagement');
const teamRouter = require('../routes/adminTeam.routes');
const accessRouter = require('../routes/access.routes');
const authRouter = require('../routes/auth.routes');
const accountRouter = require('../routes/adminAccount.routes');

const STAFF_ID = '507f1f77bcf86cd799439061';
const FOUNDER_ID = '507f1f77bcf86cd799439062';
const future = () => new Date(Date.now() + 600000).toISOString();
const past = () => new Date(Date.now() - 600000).toISOString();

function staff(patch = {}) {
  return {
    _id: STAFF_ID,
    email: 'synthetic-staff@example.invalid',
    name: 'Synthetic Staff',
    staffId: 'NP-2026-0061',
    role: 'editor',
    status: 'active',
    accountStatus: 'active',
    loginAllowed: true,
    permissions: [],
    tokenVersion: 0,
    ...patch,
  };
}

function configured(patch = {}) {
  return staff({ specialRightsConfigured: true, specialRightsOverride: [], ...patch });
}

test('legacy absent, null, empty and populated overrides keep the previous additive behavior', () => {
  const roleDoc = { specialRights: ['news_publish', 'news_approve'] };
  for (const marker of [undefined, null, false]) {
    for (const override of [undefined, null, [], ['news_edit']]) {
      const user = staff({
        specialRightsConfigured: marker,
        specialRightsOverride: override,
        permissions: ['auth.reset_password'],
        temporaryAccess: [{ rightKey: 'news_create', enabled: true, expiresAt: future() }],
      });
      const expected = [...roleDoc.specialRights, ...(override || []), 'staff_reset_password', 'news_create'];
      assert.deepEqual(effectiveSpecialRights(user, roleDoc), expected);
      assert.equal(hasPermission(user, 'auth.reset_password'), true);
      assert.equal(safeUserDto(user).specialRightsConfigured, false);
    }
  }
  assert.deepEqual(effectiveSpecialRights(staff()), ROLE_DEFAULT_ACCESS.editor.specialRights);
});

test('only a true marker opts in; hydration and serialization do not configure old arrays', () => {
  for (const value of [undefined, null, [], ['news_edit']]) {
    const source = staff({ specialRightsOverride: value });
    const hydrated = User.hydrate(source);
    const created = new User(source);
    for (const user of [hydrated, created]) {
      assert.equal(user.specialRightsConfigured, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(user.toObject(), 'specialRightsConfigured'), false);
      const reloaded = User.hydrate(JSON.parse(JSON.stringify(user)));
      assert.equal(reloaded.specialRightsConfigured, undefined);
      assert.equal(effectiveSpecialRights(reloaded).includes('news_publish'), true);
    }
  }
  assert.equal(effectiveSpecialRights(staff({ specialRightsConfigured: 'true', specialRightsOverride: [] })).includes('news_publish'), true);
});

test('configured empty and selected permanent rights replace presets and legacy permanent rights', () => {
  for (const selection of [[], ['news_edit'], ['news_publish']]) {
    const user = configured({ specialRightsOverride: selection, permissions: ['auth.reset_password', 'news_publish'] });
    const roleDoc = { specialRights: ['news_publish', 'news_delete', 'staff_reset_password'] };
    assert.deepEqual(effectiveSpecialRights(user, roleDoc), selection);
    assert.deepEqual(effectiveSpecialRights(user), selection);
    const result = computeEffectiveAccess(user, roleDoc);
    assert.equal(result.specialRightsConfigured, true);
    assert.deepEqual(result.effectiveSpecialRights, selection);
    for (const key of ['news_edit', 'news_publish', 'news_delete', 'staff_reset_password']) {
      const right = result.specialRights.find((entry) => entry.key === key);
      assert.equal(right.allowed, selection.includes(key));
      assert.equal(right.state, selection.includes(key) ? 'enabled' : 'disabled');
    }
  }
});

test('configured missing or null arrays fail closed without restoring legacy defaults', () => {
  for (const override of [undefined, null]) {
    assert.deepEqual(effectiveSpecialRights(configured({ specialRightsOverride: override })), []);
  }
});

test('canonical keys and legacy aliases cannot restore removed configured rights', () => {
  const user = configured({
    specialRightsOverride: ['news_edit'],
    permissions: ['news_publish', 'auth.reset_password', 'team.manage', 'view_marketing_performance', 'staff_activity_view_all'],
  });
  assert.deepEqual(effectiveSpecialRights(user), ['news_edit']);
  for (const key of ['news_publish', 'auth.reset_password', 'team.manage', 'view_marketing_performance']) {
    assert.equal(effectivePermissions(user).includes(key), false);
    assert.equal(hasPermission(user, key), false);
  }
  assert.equal(hasPermission(user, 'news_edit'), true);
  assert.equal(effectivePermissions(user).includes('staff_activity_view_all'), true);
  assert.equal(effectivePermissions(user).includes('staff_activity_view_own'), true);
});

test('asymmetric legacy mappings do not escalate a selected right through a round trip', () => {
  const user = configured({ specialRightsOverride: ['role_edit'], permissions: ['team.manage'] });
  assert.deepEqual(effectiveSpecialRights(user), ['role_edit']);
  assert.equal(hasPermission(user, 'team.manage'), false);
  assert.equal(hasSpecialRight(user, 'staff_create'), false);
  assert.equal(effectivePermissions(user).includes('team.manage'), false);
});

test('temporary grants and denials are separate from configured permanent selections', () => {
  const user = configured({
    specialRightsOverride: ['news_edit'],
    permissions: ['news_edit', 'news_publish'],
    temporaryAccess: [
      { rightKey: 'news_publish', enabled: true, expiresAt: future() },
      { rightKey: 'news_edit', enabled: false, expiresAt: future() },
    ],
  });
  assert.deepEqual(effectiveSpecialRights(user), ['news_publish']);
  const result = computeEffectiveAccess(user);
  assert.equal(result.specialRights.find((entry) => entry.key === 'news_publish').state, 'temporary');
  assert.equal(result.specialRights.find((entry) => entry.key === 'news_edit').state, 'disabled');
  const dto = safeUserDto(user);
  assert.deepEqual(dto.specialRightsOverride, ['news_edit']);
  assert.deepEqual(dto.specialRights, ['news_publish']);
  assert.deepEqual(user.specialRightsOverride, ['news_edit']);
  assert.equal(hasPermission(user, 'news_edit'), false);
  assert.equal(hasPermission(user, 'news_publish'), true);

  user.temporaryAccess[0].expiresAt = past();
  assert.deepEqual(effectiveSpecialRights(user), []);
  assert.equal(hasPermission(user, 'news_publish'), false);
});

test('temporary expiration boundary, invalid dates and legacy null expiry retain their semantics', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const [expiresAt, allowed] of [
    [new Date(now - 1).toISOString(), false],
    [new Date(now).toISOString(), false],
    [new Date(now + 1).toISOString(), true],
    ['invalid-date', false],
    [null, true],
  ]) {
    const user = configured({ temporaryAccess: [{ rightKey: 'news_publish', enabled: true, expiresAt }] });
    assert.equal(hasSpecialRight(user, 'news_publish'), allowed);
  }
});

test('active temporary denials win over all grants and expire without modifying permanent rights', () => {
  const user = configured({
    specialRightsOverride: ['news_publish'],
    temporaryAccess: [
      { rightKey: 'news_publish', enabled: true, expiresAt: future() },
      { rightKey: 'news_publish', enabled: false, expiresAt: future() },
    ],
  });
  assert.deepEqual(effectiveSpecialRights(user), []);
  user.temporaryAccess.reverse();
  assert.deepEqual(effectiveSpecialRights(user), []);
  user.temporaryAccess.find((entry) => entry.enabled === false).expiresAt = past();
  assert.deepEqual(effectiveSpecialRights(user), ['news_publish']);
  assert.deepEqual(user.specialRightsOverride, ['news_publish']);
});

test('configured identity copies retain temporary grants and denials during repeated permission evaluation', () => {
  const user = configured({
    specialRightsOverride: ['staff_reset_password'],
    permissions: ['auth.reset_password', 'auth.lock_user'],
    temporaryAccess: [
      { rightKey: 'staff_reset_password', enabled: false, expiresAt: future() },
      { rightKey: 'staff_lock', enabled: true, expiresAt: future() },
    ],
  });
  const identity = { role: user.role, permissions: effectivePermissions(user), ...specialRightsIdentityFields(user) };
  assert.equal(hasPermission(identity, 'auth.reset_password'), false);
  assert.equal(hasPermission(identity, 'auth.lock_user'), true);
  assert.deepEqual(specialRightsIdentityFields(staff()), { specialRightsConfigured: false });
});

test('Founder access stays protected and configured staff cannot acquire Founder-only rights', () => {
  const founder = configured({ role: 'founder', accountStatus: 'suspended', temporaryAccess: [{ rightKey: 'news_publish', enabled: false, expiresAt: future() }] });
  assert.deepEqual(effectiveSpecialRights(founder), SPECIAL_RIGHT_KEYS);
  assert.equal(hasSpecialRight(founder, 'news_publish', null, true), true);
  const ordinary = configured({
    specialRightsOverride: ['founder_account_control', 'news_edit'],
    permissions: ['safe_owner_zone.full_access'],
    temporaryAccess: [{ rightKey: 'safe_zone_access', enabled: true, expiresAt: future() }],
  });
  assert.deepEqual(effectiveSpecialRights(ordinary), ['news_edit']);
  assert.equal(hasPermission(ordinary, 'safe_owner_zone.full_access'), false);
});

test('account restrictions and Safe Zone lock still deny configured special rights', () => {
  for (const restriction of [
    ...['suspended', 'locked', 'expired', 'archived', 'deleted', 'deleted_test'].map((accountStatus) => ({ accountStatus })),
    { status: 'suspended' }, { loginAllowed: false }, { isDeleted: true },
    { deletedAt: new Date() }, { lockedUntil: future() }, { accessExpiresAt: past() },
  ]) {
    const user = configured({ specialRightsOverride: ['staff_reset_password'], permissions: ['auth.reset_password'], ...restriction });
    assert.equal(hasSpecialRight(user, 'staff_reset_password'), false);
    assert.equal(hasPermission(user, 'auth.reset_password'), false);
  }
  assert.equal(hasSpecialRight(configured({ specialRightsOverride: ['news_publish'] }), 'news_publish', null, true), false);
});

test('module access, global module policy, task and account-control rights do not change with the marker', () => {
  const legacy = staff({
    moduleAccessOverride: ['manage_news', 'media'],
    moduleAccessStates: { manageNews: 'enabled', media: 'disabled', analytics: 'enabled' },
    specialRightsOverride: ['news_edit'],
    taskRightsOverride: ['task_create'],
    accountControlRightsOverride: ['staff_view_details'],
  });
  const reviewed = { ...legacy, specialRightsConfigured: true, specialRightsOverride: [] };
  const policy = { modulePolicies: normalizeModulePolicies({ manageNews: 'available', media: 'available', analytics: 'staff_locked' }) };
  assert.deepEqual(effectiveModuleAccess(reviewed), effectiveModuleAccess(legacy));
  assert.deepEqual(evaluateAllModuleAccess(reviewed, policy), evaluateAllModuleAccess(legacy, policy));
  assert.equal(hasTaskRight(reviewed, 'task_create'), true);
  assert.equal(hasAccountControlRight(reviewed, 'staff_view_details'), true);
});

describe('Founder Special Rights save and reload contracts', () => {
  let records;
  let writes;
  let audit;
  let originalReadyState;
  let originalDb;
  let app;
  let failSave;

  function query(value) {
    return { lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  }

  function tokenFor(id, claims = {}) {
    const user = records.get(id);
    return jwt.sign({ sub: id, email: user.email, role: user.role, tokenVersion: 0, type: 'access', ...claims }, process.env.JWT_SECRET, { expiresIn: '5m' });
  }

  function asFounder(method, path, body) {
    return request(app)[method](path).auth(tokenFor(FOUNDER_ID), { type: 'bearer' }).send(body);
  }

  function saveRights(body, id = STAFF_ID) {
    return asFounder('patch', `/api/admin/team/access/staff/${id}/rights`, { auditReason: 'Synthetic Founder rights review', ...body });
  }

  beforeEach(() => {
    records = new Map([
      [STAFF_ID, staff({ specialRightsOverride: [], accessVersion: 0 })],
      [FOUNDER_ID, staff({ _id: FOUNDER_ID, email: 'synthetic-founder@example.invalid', name: 'Synthetic Founder', role: 'founder', isFounder: true, isProtected: true, staffId: 'NP-FND-0001' })],
    ]);
    writes = [];
    audit = [];
    failSave = false;
    User.findById = (id) => query(records.has(String(id)) ? User.hydrate(records.get(String(id))) : null);
    User.findOne = (filter) => {
      const record = [...records.values()].find((user) => (filter.email && user.email === filter.email) || (filter.staffId && user.staffId === filter.staffId));
      return query(record ? User.hydrate(record) : null);
    };
    User.create = async (payload) => {
      const id = new mongoose.Types.ObjectId().toString();
      const record = JSON.parse(JSON.stringify({ _id: id, ...payload }));
      records.set(id, record);
      writes.push({ kind: 'create', id });
      return User.hydrate(record);
    };
    User.findByIdAndUpdate = async (id, update) => {
      if (failSave) return null;
      const current = records.get(String(id));
      if (!current) return null;
      writes.push(update);
      const next = { ...current, ...update.$set };
      for (const [key, amount] of Object.entries(update.$inc || {})) next[key] = (next[key] || 0) + amount;
      for (const [key, value] of Object.entries(update.$push || {})) next[key] = [...(next[key] || []), value];
      records.set(String(id), JSON.parse(JSON.stringify(next)));
      return User.hydrate(records.get(String(id)));
    };
    User.findOneAndUpdate = async (filter, update) => {
      const current = records.get(String(filter._id));
      if (!current || (filter.specialRightsConfigured?.$ne === true && current.specialRightsConfigured === true)) return null;
      return User.findByIdAndUpdate(filter._id, update);
    };
    Role.findById = () => query(null);
    Role.findOne = () => query(null);
    AuditLog.create = async (entry) => { audit.push(entry); return entry; };
    AuditLog.countDocuments = async () => 0;
    Counter.findOneAndUpdate = async () => ({ value: 991 });
    SiteSettings.findOne = async () => ({
      adminModulePolicy: { modulePolicies: normalizeModulePolicies({ manageNews: 'available', analytics: 'available' }), version: 1, updatedAt: new Date(), auditReason: 'Synthetic module policy' },
    });
    app = express();
    app.use(express.json());
    app.use('/api/admin/team', teamRouter);
    app.use('/api/access', accessRouter);
    app.use('/api/auth', authRouter);
    app.use('/api/admin', accountRouter);
    app.get('/synthetic/right', requireAuth, requireSpecialRight('news_publish'), (_req, res) => res.json({ allowed: true }));
    app.get('/synthetic/founder', requireFounderOnly, (_req, res) => res.json({ allowed: true }));
    app.get('/synthetic/identity', requireAuth, (req, res) => res.json({ identity: specialRightsIdentityFields(req.user), resetAllowed: hasPermission(req.user, 'auth.reset_password') }));
    app.get('/synthetic/admin-identity', requireAdminAuth, (req, res) => res.json({ identity: specialRightsIdentityFields(req.admin), resetAllowed: hasPermission(req.admin, 'auth.reset_password'), permissions: req.admin.permissions }));
    app.get('/synthetic/team-identity', teamManagement.requireTeamAuth, (req, res) => res.json({ identity: specialRightsIdentityFields(req.user), resetAllowed: hasPermission(req.user, 'auth.reset_password') }));
    originalReadyState = mongoose.connection.readyState;
    originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: () => ({}) };
    mongoose.connection.readyState = 1;
  });

  afterEach(() => {
    mongoose.connection.readyState = originalReadyState;
    mongoose.connection.db = originalDb;
  });

  test('dedicated save atomically configures empty rights and prevents inherited news_publish on reload', async () => {
    assert.equal(effectiveSpecialRights(records.get(STAFF_ID)).includes('news_publish'), true);
    const response = await saveRights({ specialRightsOverride: [], rights: [], specialRights: [] });
    assert.equal(response.status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].$set.specialRightsConfigured, true);
    assert.deepEqual(writes[0].$set.specialRightsOverride, []);
    assert.equal(writes[0].$inc.accessVersion, 1);
    assert.equal(response.body.user.specialRightsConfigured, true);
    assert.deepEqual(response.body.user.specialRightsOverride, []);
    assert.deepEqual(response.body.user.specialRights, []);
    assert.equal(response.body.data.effectiveAccess.specialRightsConfigured, true);
    assert.deepEqual(response.body.data.effectiveAccess.effectiveSpecialRights, []);
    const reload = await asFounder('get', `/api/admin/team/access/staff/${STAFF_ID}`);
    assert.equal(reload.status, 200);
    assert.equal(reload.body.user.specialRightsConfigured, true);
    assert.deepEqual(reload.body.user.specialRightsOverride, []);
    assert.equal(reload.body.effectiveAccess.specialRights.find((right) => right.key === 'news_publish').allowed, false);
    assert.equal(audit.find((entry) => entry.action === 'TEAM_SPECIAL_RIGHTS_CHANGE').meta.wasSpecialRightsConfigured, false);
  });

  test('selected permanent rights persist; news_edit does not imply news_publish', async () => {
    const response = await saveRights({ rights: ['news_edit'] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user.specialRightsOverride, ['news_edit']);
    assert.deepEqual(response.body.user.specialRights, ['news_edit']);
    const reloaded = User.hydrate(JSON.parse(JSON.stringify(records.get(STAFF_ID))));
    assert.equal(reloaded.specialRightsConfigured, true);
    assert.deepEqual(effectiveSpecialRights(reloaded), ['news_edit']);
    const denied = await request(app).get('/synthetic/right').auth(tokenFor(STAFF_ID), { type: 'bearer' });
    assert.equal(denied.status, 403);
  });

  test('explicit news_publish is recognized without granting Founder-only publishing authorization', async () => {
    const response = await saveRights({ rights: ['news_publish'] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user.specialRights, ['news_publish']);
    assert.equal((await request(app).get('/synthetic/right').auth(tokenFor(STAFF_ID), { type: 'bearer' })).status, 200);
    const denied = await request(app).get('/synthetic/founder').auth(tokenFor(STAFF_ID), { type: 'bearer' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'FOUNDER_REQUIRED');
    assert.equal((await saveRights({ rights: [] })).status, 200);
    assert.equal((await request(app).get('/synthetic/right').auth(tokenFor(STAFF_ID), { type: 'bearer' })).status, 403);
  });

  test('legacy aliases stay stored but cannot restore a cleared configured permission', async () => {
    assert.equal((await saveRights({ rights: ['staff_reset_password'] })).status, 200);
    assert.equal(records.get(STAFF_ID).permissions.includes('auth.reset_password'), true);
    const response = await saveRights({ rights: [] });
    assert.equal(response.status, 200);
    assert.equal(records.get(STAFF_ID).permissions.includes('auth.reset_password'), true);
    assert.equal(response.body.user.permissions.includes('auth.reset_password'), false);
    assert.equal(hasPermission(records.get(STAFF_ID), 'auth.reset_password'), false);
    const legacySave = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}/permissions`, { permissions: ['auth.reset_password', 'news_publish'] });
    assert.equal(legacySave.status, 200);
    assert.equal(legacySave.body.user.specialRightsConfigured, true);
    assert.deepEqual(legacySave.body.user.specialRights, []);
    assert.equal(legacySave.body.user.permissions.includes('news_publish'), false);
  });

  test('configured team actions cannot inherit broad legacy grants or unrelated selected rights', async () => {
    for (const permission of ['staff_manage', 'staff.manage', 'team.manage']) {
      for (const selection of [[], ['staff_create'], ['role_edit']]) {
        records.set(STAFF_ID, configured({ permissions: [permission], specialRightsOverride: selection }));
        const response = await request(app)
          .post(`/api/admin/team/users/${STAFF_ID}/force-password-change`)
          .auth(tokenFor(STAFF_ID), { type: 'bearer' })
          .send({});
        assert.equal(response.status, 403, `${permission}: ${selection.join(',')}`);
        assert.equal(response.body.code, 'FORBIDDEN');
      }
    }
    assert.equal(writes.length, 0);
  });

  test('unconfigured broad team grants retain their legacy behavior', async () => {
    for (const permission of ['staff_manage', 'staff.manage', 'team.manage']) {
      records.set(STAFF_ID, staff({ permissions: [permission], specialRightsOverride: [] }));
      const response = await request(app)
        .post(`/api/admin/team/users/${STAFF_ID}/force-password-change`)
        .auth(tokenFor(STAFF_ID), { type: 'bearer' })
        .send({});
      assert.equal(response.status, 200);
      assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    }
  });

  test('configured team actions retain specific rights, temporary decisions and separate account-control grants', async () => {
    for (const [patch, status] of [
      [{ specialRightsOverride: ['staff_reset_password'] }, 200],
      [{ accountControlRightsOverride: ['staff_force_password_change'] }, 200],
      [{ temporaryAccess: [{ rightKey: 'staff_reset_password', enabled: true, expiresAt: future() }] }, 200],
      [{ specialRightsOverride: ['staff_reset_password'], temporaryAccess: [{ rightKey: 'staff_reset_password', enabled: false, expiresAt: future() }] }, 403],
      [{ temporaryAccess: [{ rightKey: 'staff_reset_password', enabled: true, expiresAt: past() }] }, 403],
    ]) {
      records.set(STAFF_ID, configured({ permissions: ['staff_manage', 'auth.reset_password'], ...patch }));
      const count = writes.length;
      const response = await request(app)
        .post(`/api/admin/team/users/${STAFF_ID}/force-password-change`)
        .auth(tokenFor(STAFF_ID), { type: 'bearer' })
        .send({});
      assert.equal(response.status, status);
      if (status === 403) assert.equal(writes.length, count);
    }
  });

  test('computed aliases cannot overwrite the permanent selection during a rights save', async () => {
    records.set(STAFF_ID, configured({ specialRightsOverride: [], temporaryAccess: [{ rightKey: 'news_publish', enabled: true, expiresAt: future() }] }));
    const response = await saveRights({ specialRightsOverride: [], specialRights: ['news_publish'] });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CONFLICTING_SPECIAL_RIGHTS');
    assert.equal(writes.length, 0);
    assert.deepEqual(records.get(STAFF_ID).specialRightsOverride, []);
    const saved = await saveRights({ specialRightsOverride: [] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.user.specialRightsOverride, []);
    assert.deepEqual(saved.body.user.specialRights, ['news_publish']);
  });

  test('missing, null, malformed and client-marker payloads cannot activate configured mode', async () => {
    for (const body of [
      {}, { rights: null }, { rights: 'news_publish' },
      { specialRightsOverride: null, rights: ['news_publish'] },
      { rights: [], specialRightsConfigured: true },
      { rights: [], specialRightsConfigured: false },
    ]) {
      assert.equal((await saveRights(body)).status, 400);
      assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    }
    const noReason = await asFounder('patch', `/api/admin/team/access/staff/${STAFF_ID}/rights`, { rights: [] });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'AUDIT_REASON_REQUIRED');
    assert.equal(writes.length, 0);
  });

  test('key maps, matching aliases and Founder-only filtering retain compatible save behavior', async () => {
    const response = await saveRights({
      specialRightsOverride: { news_edit: true, news_publish: false, founder_account_control: true },
      rights: ['founder_account_control', 'news_edit'],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user.specialRightsOverride, ['news_edit']);
    assert.deepEqual(response.body.blockedFounderOnly, ['founder_account_control']);
    assert.equal(response.body.user.specialRightsConfigured, true);
  });

  test('only an authenticated Founder may activate the marker and protected targets remain blocked', async () => {
    assert.equal((await request(app).patch(`/api/admin/team/access/staff/${STAFF_ID}/rights`).send({ rights: [] })).status, 401);
    const denied = await request(app).patch(`/api/admin/team/access/staff/${STAFF_ID}/rights`).auth(tokenFor(STAFF_ID), { type: 'bearer' }).send({ rights: ['news_publish'], auditReason: 'Synthetic unauthorized request' });
    assert.equal(denied.status, 403);
    const forged = await request(app).patch(`/api/admin/team/access/staff/${STAFF_ID}/rights`).auth(tokenFor(STAFF_ID, { role: 'founder', specialRightsConfigured: true }), { type: 'bearer' }).send({ rights: [], auditReason: 'Synthetic forged claims' });
    assert.equal(forged.status, 403);
    const protectedTarget = await saveRights({ rights: [] }, FOUNDER_ID);
    assert.equal(protectedTarget.status, 403);
    assert.equal(protectedTarget.body.code, 'FOUNDER_PROTECTED');
    assert.equal(writes.length, 0);
  });

  test('failed persistence cannot leave a marker-only transition', async () => {
    failSave = true;
    const response = await saveRights({ rights: [] });
    assert.equal(response.status, 404);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    assert.equal(writes.length, 0);
  });

  test('general updates and legacy combined access preserve unconfigured behavior', async () => {
    const updated = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}`, { fullName: 'Synthetic Updated Staff', specialRightsOverride: [] });
    assert.equal(updated.status, 200);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    assert.equal(updated.body.user.specialRights.includes('news_publish'), true);
    const combined = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}/access`, { specialRightsOverride: ['news_edit'] });
    assert.equal(combined.status, 200);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    assert.equal(combined.body.user.specialRights.includes('news_publish'), true);
  });

  test('configured rights cannot be overwritten through general or legacy combined updates', async () => {
    assert.equal((await saveRights({ rights: [] })).status, 200);
    const count = writes.length;
    for (const path of [`/api/admin/team/users/${STAFF_ID}`, `/api/admin/team/users/${STAFF_ID}/access`]) {
      const response = await asFounder('patch', path, { specialRights: ['news_publish'] });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'SPECIAL_RIGHTS_SAVE_REQUIRED');
      const marker = await asFounder('patch', path, { specialRightsConfigured: false, fullName: 'Synthetic Staff' });
      assert.equal(marker.status, 400);
      assert.equal(marker.body.code, 'SPECIAL_RIGHTS_CONFIGURED_READ_ONLY');
    }
    assert.equal(writes.length, count);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, true);
    assert.deepEqual(records.get(STAFF_ID).specialRightsOverride, []);
  });

  for (const suffix of ['', '/access']) {
    test(`in-flight ${suffix || 'general'} legacy saves cannot overwrite an intentional Founder save`, async (t) => {
      const findById = User.findById;
      let nextSelection;
      t.mock.method(User, 'findById', (id) => {
        const snapshot = findById(id);
        if (String(id) !== STAFF_ID || nextSelection === undefined) return snapshot;
        const selection = nextSelection;
        nextSelection = undefined;
        return {
          then(resolve, reject) {
            return saveRights({ specialRightsOverride: selection }).then((response) => {
              assert.equal(response.status, 200);
              return snapshot;
            }).then(resolve, reject);
          },
        };
      });

      for (const selection of [[], ['news_edit']]) {
        records.set(STAFF_ID, staff({ specialRightsOverride: [], moduleAccessOverride: [], accessVersion: 0 }));
        nextSelection = selection;
        const response = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}${suffix}`, {
          specialRights: ['news_publish'],
          moduleAccessOverride: ['analytics'],
        });
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'SPECIAL_RIGHTS_SAVE_REQUIRED');
        const saved = records.get(STAFF_ID);
        assert.equal(saved.specialRightsConfigured, true);
        assert.deepEqual(saved.specialRightsOverride, selection);
        assert.deepEqual(saved.moduleAccessOverride, []);
        assert.equal(saved.accessVersion, 1);
        assert.equal(hasSpecialRight(saved, 'news_publish'), false);
      }
    });
  }

  test('ordinary profile, role and module-only changes preserve the configured selection', async () => {
    assert.equal((await saveRights({ rights: ['news_edit'] })).status, 200);
    const updated = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}`, { fullName: 'Synthetic Updated Staff', role: 'manager' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.specialRightsConfigured, true);
    assert.deepEqual(updated.body.user.specialRights, ['news_edit']);
    const modules = await asFounder('patch', `/api/admin/team/users/${STAFF_ID}/access`, { moduleAccessOverride: ['analytics'] });
    assert.equal(modules.status, 200);
    assert.deepEqual(modules.body.user.specialRightsOverride, ['news_edit']);
    assert.equal(modules.body.user.specialRightsConfigured, true);
    assert.deepEqual(records.get(STAFF_ID).moduleAccessOverride, ['analytics']);
  });

  test('creation with omitted or supplied preset rights never activates configured mode', async () => {
    for (const [index, selection] of [undefined, ['news_edit'], ['news_publish']].entries()) {
      const response = await asFounder('post', '/api/admin/team/team/users', {
        fullName: 'Synthetic New Staff',
        email: `synthetic-created-${index}@example.invalid`,
        role: 'editor',
        staffId: `NP-2026-099${index}`,
        ...(selection ? { specialRightsOverride: selection } : {}),
      });
      assert.equal(response.status, 201);
      const id = response.body.data.user.id;
      assert.equal(records.get(id).specialRightsConfigured, undefined);
      assert.equal(records.get(id).newsPublishGrant, undefined);
      assert.equal(hasRecordedNewsPublishGrant(records.get(id)), false);
      assert.equal(response.body.data.user.specialRightsConfigured, false);
      assert.equal(response.body.data.user.newsPublishGrantRecorded, false);
      assert.equal(response.body.data.user.specialRights.includes('news_publish'), true);
    }
    const rejected = await asFounder('post', '/api/admin/team/team/users', {
      fullName: 'Synthetic Rejected Staff', email: 'synthetic-rejected@example.invalid',
      role: 'editor', specialRightsConfigured: true,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'SPECIAL_RIGHTS_CONFIGURED_READ_ONLY');
  });

  test('delegated staff creation cannot forge a Founder temporary publication grant', async () => {
    records.set(STAFF_ID, configured({ specialRightsOverride: ['staff_create'] }));
    const response = await request(app).post('/api/admin/team/team/users')
      .auth(tokenFor(STAFF_ID), { type: 'bearer' }).send({
        fullName: 'Synthetic Delegated Staff', email: 'synthetic-delegated@example.invalid',
        role: 'intern', staffId: 'NP-2026-0981',
        temporaryAccess: [{ rightKey: 'news_publish', enabled: true, expiresAt: future(), grantedBy: FOUNDER_ID }],
      });
    assert.equal(response.status, 201, response.text);
    const user = records.get(response.body.data.user.id);
    assert.equal(user.temporaryAccess[0].grantedBy, STAFF_ID);
    assert.equal(user.temporaryAccess[0].newsPublishGrant, undefined);
    assert.equal(hasRecordedNewsPublishGrant(user), false);
  });

  test('publication provenance inputs are rejected by rights, staff creation and general account updates', async () => {
    const newsPublishGrant = {
      source: GRANT_SOURCE, subjectUserId: STAFF_ID, grantedBy: FOUNDER_ID, grantedAt: past(),
    };
    for (const [method, path, body] of [
      ['patch', `/api/admin/team/access/staff/${STAFF_ID}/rights`, { rights: ['news_publish'], newsPublishGrant }],
      ['post', `/api/admin/team/access/staff/${STAFF_ID}/temporary`, { rightKey: 'news_publish', expiresAt: future(), newsPublishGrant }],
      ['patch', `/api/admin/team/users/${STAFF_ID}`, { fullName: 'Synthetic User', newsPublishGrant }],
      ['patch', `/api/admin/team/users/${STAFF_ID}/access`, { newsPublishGrant }],
      ['post', '/api/admin/team/team/users', { fullName: 'Synthetic User', email: 'synthetic-proof@example.invalid', newsPublishGrant }],
      ['post', '/api/admin/team/team/users', {
        fullName: 'Synthetic User', email: 'synthetic-proof@example.invalid',
        temporaryAccess: [{ rightKey: 'news_publish', expiresAt: future(), newsPublishGrant }],
      }],
    ]) {
      const response = await asFounder(method, path, { ...body, auditReason: 'Synthetic input validation' });
      assert.equal(response.status, 400, response.text);
      assert.equal(response.body.code, 'PUBLICATION_GRANT_READ_ONLY');
    }
    const profile = await request(app).patch('/api/admin/account/profile')
      .auth(tokenFor(STAFF_ID), { type: 'bearer' }).send({ fullName: 'Synthetic Profile', newsPublishGrant });
    assert.equal(profile.status, 400);
    assert.equal(profile.body.code, 'PROTECTED_FIELDS');
    assert.equal(writes.length, 0);
  });

  test('Founder re-saving historical rights records provenance and revocation atomically removes it', async () => {
    records.set(STAFF_ID, configured({ specialRightsOverride: ['news_publish'] }));
    assert.equal(hasRecordedNewsPublishGrant(records.get(STAFF_ID)), false);
    const modulesBefore = records.get(STAFF_ID).moduleAccessOverride;
    const granted = await saveRights({ rights: ['news_publish'], grantedBy: STAFF_ID });
    assert.equal(granted.status, 200);
    const saved = records.get(STAFF_ID);
    assert.equal(saved.newsPublishGrant.grantedBy, FOUNDER_ID);
    assert.equal(saved.newsPublishGrant.subjectUserId, STAFF_ID);
    assert.equal(granted.body.user.newsPublishGrantRecorded, true);
    assert.equal(granted.body.user.newsPublishGrant, undefined);
    assert.deepEqual(saved.moduleAccessOverride, modulesBefore);
    assert.deepEqual(saved.specialRightsOverride, ['news_publish']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].$set.newsPublishGrant.source, GRANT_SOURCE);
    for (const path of ['/api/access/me', '/api/access/my-modules']) {
      const access = await request(app).get(path).auth(tokenFor(STAFF_ID), { type: 'bearer' });
      assert.equal(access.status, 200);
      assert.equal(access.body.data.newsPublishGrantRecorded, true);
    }
    assert.equal((await saveRights({ rights: [] })).status, 200);
    assert.equal(records.get(STAFF_ID).newsPublishGrant, null);
    assert.equal(hasRecordedNewsPublishGrant(records.get(STAFF_ID)), false);
    assert.equal(writes.length, 2);
  });

  test('access DTOs expose the marker without confusing saved and temporary effective rights', async () => {
    records.set(STAFF_ID, staff({ specialRightsOverride: [], temporaryAccess: [{ rightKey: 'news_publish', enabled: true, expiresAt: future() }] }));
    assert.equal((await saveRights({ rights: [] })).status, 200);
    const me = await request(app).get('/api/access/me').auth(tokenFor(STAFF_ID), { type: 'bearer' });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.specialRightsConfigured, true);
    assert.deepEqual(me.body.data.specialRights.specialRights, []);
    const modules = await request(app).get('/api/access/my-modules').auth(tokenFor(STAFF_ID), { type: 'bearer' });
    assert.equal(modules.status, 200);
    assert.equal(modules.body.specialRightsConfigured, true);
    assert.equal(modules.body.data.specialRightsConfigured, true);
    assert.deepEqual(modules.body.specialRights, ['news_publish']);
    const authMe = await request(app).get('/api/auth/me').auth(tokenFor(STAFF_ID), { type: 'bearer' });
    assert.equal(authMe.status, 200);
    assert.equal(authMe.body.access.specialRightsConfigured, true);
    assert.deepEqual(authMe.body.access.specialRights.specialRights, []);
  });

  test('My Account cannot set or reset the marker and ordinary profile changes preserve it', async () => {
    for (const marker of [undefined, true]) {
      records.set(STAFF_ID, staff({ specialRightsConfigured: marker, specialRightsOverride: [] }));
      const response = await request(app).patch('/api/admin/account/profile')
        .auth(tokenFor(STAFF_ID), { type: 'bearer' })
        .send({ fullName: 'Synthetic Profile', specialRightsConfigured: marker !== true });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'PROTECTED_FIELDS');
      assert.equal(records.get(STAFF_ID).specialRightsConfigured, marker);
    }
    assert.equal(writes.length, 0);
    const updated = await request(app).patch('/api/admin/account/profile')
      .auth(tokenFor(STAFF_ID), { type: 'bearer' })
      .send({ fullName: 'Synthetic Profile' });
    assert.equal(updated.status, 200);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, true);
    assert.deepEqual(records.get(STAFF_ID).specialRightsOverride, []);
  });

  test('bearer, admin and cookie team projections preserve configured temporary denials', async () => {
    records.set(STAFF_ID, configured({
      specialRightsOverride: ['staff_reset_password'],
      permissions: ['auth.reset_password', 'news_publish'],
      temporaryAccess: [{ rightKey: 'staff_reset_password', enabled: false, expiresAt: future() }],
    }));
    for (const path of ['/synthetic/identity', '/synthetic/admin-identity', '/synthetic/team-identity']) {
      for (const cookie of [false, true]) {
        const call = request(app).get(path);
        const response = await (cookie ? call.set('Cookie', `np_admin_token=${encodeURIComponent(tokenFor(STAFF_ID))}`) : call.auth(tokenFor(STAFF_ID), { type: 'bearer' }));
        assert.equal(response.status, 200);
        assert.equal(response.body.identity.specialRightsConfigured, true);
        assert.deepEqual(response.body.identity.specialRightsOverride, ['staff_reset_password']);
        assert.equal(response.body.identity.temporaryAccess[0].enabled, false);
        assert.equal(response.body.resetAllowed, false);
      }
    }
  });

  test('temporary API writes do not configure permanent rights, and expiry and Founder-only checks remain', async () => {
    for (const payload of [
      { rightKey: 'news_publish' },
      { rightKey: 'news_publish', expiresAt: past() },
      { rightKey: 'founder_account_control', expiresAt: future() },
    ]) {
      const response = await asFounder('post', `/api/admin/team/access/staff/${STAFF_ID}/temporary`, { ...payload, auditReason: 'Synthetic temporary access' });
      assert.ok([400, 403].includes(response.status));
    }
    assert.equal(writes.length, 0);
    const granted = await asFounder('post', `/api/admin/team/access/staff/${STAFF_ID}/temporary`, { rightKey: 'news_publish', expiresAt: future(), enabled: false, auditReason: 'Synthetic temporary denial' });
    assert.equal(granted.status, 201);
    assert.equal(records.get(STAFF_ID).specialRightsConfigured, undefined);
    assert.equal(hasSpecialRight(records.get(STAFF_ID), 'news_publish'), false);
  });

  test('authenticated action checks still enforce suspension, account locks and Safe Zone master lock', async () => {
    assert.equal((await saveRights({ rights: ['news_publish'] })).status, 200);
    const saved = records.get(STAFF_ID);
    for (const accountStatus of ['suspended', 'locked']) {
      records.set(STAFF_ID, { ...saved, accountStatus });
      assert.equal((await request(app).get('/synthetic/right').auth(tokenFor(STAFF_ID), { type: 'bearer' })).status, 403);
    }
    records.set(STAFF_ID, saved);
    const oldLock = process.env.SAFE_ZONE_MASTER_LOCK;
    try {
      process.env.SAFE_ZONE_MASTER_LOCK = 'true';
      assert.equal((await request(app).get('/synthetic/right').auth(tokenFor(STAFF_ID), { type: 'bearer' })).status, 403);
      assert.equal((await request(app).get('/synthetic/founder').auth(tokenFor(FOUNDER_ID), { type: 'bearer' })).status, 200);
    } finally {
      if (oldLock === undefined) delete process.env.SAFE_ZONE_MASTER_LOCK;
      else process.env.SAFE_ZONE_MASTER_LOCK = oldLock;
    }
  });
});
