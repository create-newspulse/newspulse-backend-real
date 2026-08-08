process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'founder-access-control-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const SiteSettings = require('../models/SiteSettings');
const User = require('../models/User');
const Role = require('../models/Role');
const AuditLog = require('../models/AuditLog');
const safeZoneRouter = require('../routes/adminSafeOwnerZoneFeatureVisibility.routes');
const accessRoutes = require('../routes/access.routes');
const authRoutes = require('../routes/auth.routes');
const { requireAuth, requireModuleAccess } = require('../middleware/requireAuth');
const {
  BULK_FOUNDER_ONLY_ACTION,
  BULK_FOUNDER_ONLY_CONFIRMATION,
  evaluateModuleAccess,
  modulePoliciesFromLegacyVisibility,
  normalizeModulePolicies,
  validatePolicyPatch,
} = require('../services/founderAccessPolicyService');

const STAFF_ID = '507f1f77bcf86cd799439041';
const FOUNDER_ID = '507f1f77bcf86cd799439099';

let originalReadyState;
let originalDb;
let siteSettingsDoc;
let currentUser;
let founderUser;
let auditDocs;
let failSave;

function queryResult(value) {
  return {
    lean: async () => value,
    select: async () => value,
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function signToken(overrides = {}) {
  return jwt.sign(
    {
      sub: overrides.sub || (overrides.role === 'founder' ? FOUNDER_ID : STAFF_ID),
      email: overrides.email || 'editor@example.com',
      name: overrides.name || 'Editor',
      role: overrides.role || 'editor',
      tokenVersion: 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeUser(overrides = {}) {
  return {
    _id: overrides._id || STAFF_ID,
    id: overrides._id || STAFF_ID,
    email: overrides.email || 'editor@example.com',
    name: overrides.name || 'Editor',
    fullName: overrides.name || 'Editor',
    role: overrides.role || 'editor',
    roleName: overrides.role || 'editor',
    staffId: overrides.staffId || 'NP-STF-0041',
    position: overrides.position || 'Editor',
    status: overrides.status || 'active',
    accountStatus: overrides.accountStatus || 'active',
    loginAllowed: overrides.loginAllowed !== false,
    tokenVersion: 0,
    accessVersion: overrides.accessVersion || 0,
    permissions: overrides.permissions || [],
    moduleAccessOverride: overrides.moduleAccessOverride || [],
    moduleAccessStates: overrides.moduleAccessStates,
    specialRightsOverride: overrides.specialRightsOverride || [],
    taskRightsOverride: overrides.taskRightsOverride || [],
    accountControlRightsOverride: overrides.accountControlRightsOverride || [],
    temporaryAccess: overrides.temporaryAccess || [],
    isFounder: overrides.role === 'founder' || overrides.isFounder === true,
    isProtected: overrides.role === 'founder' || overrides.isProtected === true,
    lockedUntil: overrides.lockedUntil || null,
    accessExpiresAt: overrides.accessExpiresAt || null,
    ...overrides,
  };
}

function buildPolicy(overrides = {}) {
  return {
    modulePolicies: normalizeModulePolicies(overrides),
    version: 7,
    updatedAt: new Date('2026-08-06T00:00:00.000Z'),
    updatedBy: 'founder@example.com',
    auditReason: 'test policy',
  };
}

function buildSafeZoneApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', safeZoneRouter);
  return app;
}

function buildAccessApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/access', accessRoutes);
  app.use('/api/auth', authRoutes);
  app.get('/secure-add-news', requireAuth, requireModuleAccess('add_news'), (_req, res) => res.json({ ok: true }));
  app.get('/secure-community-queue', requireAuth, requireModuleAccess('community_reporter_queue'), (_req, res) => res.json({ ok: true }));
  app.get('/secure-finance', requireAuth, requireModuleAccess('finance_desk'), (_req, res) => res.json({ ok: true }));
  return app;
}

test.beforeEach(() => {
  originalReadyState = mongoose.connection.readyState;
  originalDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = { collection: () => ({}) };
  auditDocs = [];
  failSave = false;
  siteSettingsDoc = {
    _id: '507f1f77bcf86cd799439055',
    adminFeatureVisibility: { addNews: true, analytics: false },
    adminModulePolicy: buildPolicy({ financeDesk: 'available', analytics: 'hidden' }),
    updatedAt: new Date('2026-08-06T00:00:00.000Z'),
    async save() {
      if (failSave) throw new Error('save failed');
      return this;
    },
  };
  currentUser = makeUser({ moduleAccessOverride: ['finance_desk'], specialRightsOverride: ['finance_view'] });
  founderUser = makeUser({ _id: FOUNDER_ID, email: 'founder@example.com', name: 'Founder', role: 'founder', isFounder: true, staffId: 'NP-FND-0001' });

  SiteSettings.findOne = async () => siteSettingsDoc;
  SiteSettings.create = async (payload) => {
    siteSettingsDoc = { _id: '507f1f77bcf86cd799439056', ...payload, async save() { if (failSave) throw new Error('save failed'); return this; } };
    return siteSettingsDoc;
  };
  SiteSettings.findOneAndUpdate = async (filter, update) => {
    if (failSave) throw new Error('save failed');
    if (filter?._id && String(filter._id) !== String(siteSettingsDoc._id)) return null;
    if (Object.prototype.hasOwnProperty.call(filter || {}, 'adminModulePolicy.version') && siteSettingsDoc.adminModulePolicy?.version !== filter['adminModulePolicy.version']) return null;
    if (update?.$set?.adminModulePolicy) siteSettingsDoc.adminModulePolicy = update.$set.adminModulePolicy;
    return siteSettingsDoc;
  };
  User.findById = (id) => queryResult(String(id) === String(currentUser._id) ? currentUser : (String(id) === String(founderUser._id) ? founderUser : null));
  User.findOne = (filter) => queryResult(
    filter?.email === currentUser.email || filter?.staffId === currentUser.staffId ? currentUser
      : (filter?.email === founderUser.email || filter?.staffId === founderUser.staffId ? founderUser : null),
  );
  User.findByIdAndUpdate = async (id, update) => {
    if (String(id) !== String(currentUser._id)) return null;
    if (update?.$set) Object.assign(currentUser, update.$set);
    if (update?.$inc?.accessVersion) currentUser.accessVersion = (currentUser.accessVersion || 0) + update.$inc.accessVersion;
    return currentUser;
  };
  Role.findById = () => queryResult(null);
  Role.findOne = () => queryResult(null);
  AuditLog.create = async (doc) => { auditDocs.push(doc); return doc; };
  AuditLog.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => auditDocs }) }) });
});

test.afterEach(() => {
  mongoose.connection.readyState = originalReadyState;
  mongoose.connection.db = originalDb;
});

test('legacy visibility migrates to module policy without resetting existing production settings', () => {
  const migrated = modulePoliciesFromLegacyVisibility({ addNews: true, analytics: false, unknown: false });
  assert.equal(migrated.addNews, 'available');
  assert.equal(migrated.analytics, 'hidden');
  assert.equal(migrated.manageNews, 'founder_only');
  assert.equal(migrated.safeZone, 'founder_only');
});

test('legacy stored module policy without version is upgraded to version 1 without changing policy values', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });
  siteSettingsDoc.adminModulePolicy = {
    modulePolicies: normalizeModulePolicies({ financeDesk: 'available', analytics: 'hidden', liveTv: 'available' }),
    updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    updatedBy: 'legacy-founder@example.com',
    auditReason: 'legacy policy',
  };

  const res = await request(app)
    .get('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.version, 1);
  assert.equal(res.body.updatedBy, 'legacy-founder@example.com');
  assert.equal(res.body.policy.modulePolicies.financeDesk, 'available');
  assert.equal(res.body.policy.modulePolicies.analytics, 'hidden');
  assert.equal(res.body.policy.modulePolicies.liveTv, 'available');
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 1);
  assert.equal(siteSettingsDoc.adminModulePolicy.modulePolicies.financeDesk, 'available');
  assert.equal(siteSettingsDoc.adminModulePolicy.modulePolicies.analytics, 'hidden');
  assert.equal(siteSettingsDoc.adminModulePolicy.modulePolicies.liveTv, 'available');
});

test('missing module defaults to founder_only while existing available policy remains available', () => {
  const staff = makeUser({ moduleAccessOverride: ['add_news', 'finance_desk'] });
  assert.equal(evaluateModuleAccess(staff, 'addNews', { modulePolicies: { financeDesk: 'available' } }).reasonCode, 'FOUNDER_ONLY');
  assert.equal(evaluateModuleAccess(staff, 'financeDesk', { modulePolicies: { financeDesk: 'available' } }).reasonCode, 'ALLOWED');
});

test('effective access resolves global, individual, temporary and account states', () => {
  const founder = makeUser({ role: 'founder', isFounder: true, moduleAccessOverride: [] });
  assert.equal(evaluateModuleAccess(founder, 'safeZone', buildPolicy({ safeZone: 'hidden' })).allowed, true);

  const enabled = makeUser({ moduleAccessStates: { financeDesk: 'enabled' }, moduleAccessOverride: [] });
  assert.equal(evaluateModuleAccess(enabled, 'financeDesk', buildPolicy({ financeDesk: 'available' })).reasonCode, 'ALLOWED');

  const disabled = makeUser({ moduleAccessStates: { financeDesk: 'disabled' }, moduleAccessOverride: [] });
  assert.equal(evaluateModuleAccess(disabled, 'financeDesk', buildPolicy({ financeDesk: 'available' })).reasonCode, 'STAFF_ACCESS_DISABLED');

  const hidden = evaluateModuleAccess(enabled, 'financeDesk', buildPolicy({ financeDesk: 'hidden' }));
  assert.equal(hidden.visible, false);
  assert.equal(hidden.reasonCode, 'MODULE_HIDDEN');

  assert.equal(evaluateModuleAccess(enabled, 'financeDesk', buildPolicy({ financeDesk: 'staff_locked' })).reasonCode, 'GLOBAL_STAFF_LOCK');
  assert.equal(evaluateModuleAccess(enabled, 'safeZone', buildPolicy({ safeZone: 'available' })).reasonCode, 'FOUNDER_ONLY');

  const expiredTemporary = makeUser({
    moduleAccessOverride: [],
    temporaryAccess: [{ moduleKey: 'finance_desk', enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() }],
  });
  assert.equal(evaluateModuleAccess(expiredTemporary, 'financeDesk', buildPolicy({ financeDesk: 'available' })).reasonCode, 'TEMPORARY_ACCESS_EXPIRED');

  const validTemporary = makeUser({
    moduleAccessOverride: [],
    temporaryAccess: [{ moduleKey: 'finance_desk', enabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() }],
  });
  assert.equal(evaluateModuleAccess(validTemporary, 'financeDesk', buildPolicy({ financeDesk: 'available' })).allowed, true);

  assert.equal(evaluateModuleAccess(makeUser({ accessExpiresAt: new Date(Date.now() - 1000) }), 'financeDesk', buildPolicy()).reasonCode, 'ACCOUNT_EXPIRED');
  assert.equal(evaluateModuleAccess(makeUser({ status: 'suspended' }), 'financeDesk', buildPolicy()).reasonCode, 'ACCOUNT_SUSPENDED');
  assert.equal(evaluateModuleAccess(makeUser({ accountStatus: 'locked' }), 'financeDesk', buildPolicy()).reasonCode, 'ACCOUNT_LOCKED');
  assert.equal(evaluateModuleAccess(makeUser({ loginAllowed: false }), 'financeDesk', buildPolicy()).reasonCode, 'ACCOUNT_INACTIVE');

  const rightsOnly = makeUser({ moduleAccessOverride: [], specialRightsOverride: ['finance_create_invoice'] });
  assert.equal(evaluateModuleAccess(rightsOnly, 'financeDesk', buildPolicy({ financeDesk: 'available' })).allowed, false);
});

test('authoritative module access service covers global staff individual temporary founder and role-preset cases', () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const policy = buildPolicy({
    addNews: 'available',
    manageNews: 'available',
    draftDesk: 'staff_locked',
    analytics: 'hidden',
    media: 'founder_only',
    liveTv: 'available',
    viralVideos: 'available',
  });
  const user = makeUser({
    role: 'editor',
    moduleAccessStates: {
      addNews: 'enabled',
      manageNews: 'disabled',
      draftDesk: 'enabled',
      analytics: 'enabled',
      media: 'enabled',
    },
    moduleAccessOverride: [],
    temporaryAccess: [
      { moduleKey: 'live_tv', enabled: true, expiresAt: '2026-08-07T12:05:00.000Z' },
      { moduleKey: 'viral_videos', enabled: true, expiresAt: '2026-08-07T11:55:00.000Z' },
    ],
  });
  const shape = ({ visible, allowed, globalState, individualState, reasonCode }) => ({ visible, allowed, globalState, individualState, reasonCode });

  assert.deepEqual(shape(evaluateModuleAccess(user, 'addNews', policy, { now })), { visible: true, allowed: true, globalState: 'available', individualState: 'enabled', reasonCode: 'ALLOWED' });
  assert.deepEqual(shape(evaluateModuleAccess(user, 'manageNews', policy, { now })), { visible: true, allowed: false, globalState: 'available', individualState: 'disabled', reasonCode: 'STAFF_ACCESS_DISABLED' });
  assert.deepEqual(shape(evaluateModuleAccess(user, 'draftDesk', policy, { now })), { visible: true, allowed: false, globalState: 'staff_locked', individualState: 'enabled', reasonCode: 'GLOBAL_STAFF_LOCK' });
  assert.deepEqual(shape(evaluateModuleAccess(user, 'analytics', policy, { now })), { visible: false, allowed: false, globalState: 'hidden', individualState: 'enabled', reasonCode: 'MODULE_HIDDEN' });
  assert.deepEqual(shape(evaluateModuleAccess(user, 'media', policy, { now })), { visible: true, allowed: false, globalState: 'founder_only', individualState: 'enabled', reasonCode: 'FOUNDER_ONLY' });
  assert.equal(evaluateModuleAccess(makeUser({ accessExpiresAt: new Date('2026-08-07T11:00:00.000Z'), noExpiry: false }), 'addNews', policy, { now }).reasonCode, 'ACCOUNT_EXPIRED');
  assert.equal(evaluateModuleAccess(makeUser({ status: 'suspended', accountStatus: 'suspended', loginAllowed: false }), 'addNews', policy, { now }).reasonCode, 'ACCOUNT_SUSPENDED');
  assert.deepEqual(shape(evaluateModuleAccess(user, 'liveTv', policy, { now })), { visible: true, allowed: true, globalState: 'available', individualState: 'temporary', reasonCode: 'ALLOWED' });
  assert.equal(evaluateModuleAccess(user, 'viralVideos', policy, { now }).reasonCode, 'TEMPORARY_ACCESS_EXPIRED');
  assert.equal(evaluateModuleAccess(founderUser, 'media', policy, { now }).allowed, true);

  const editorPresetOnly = makeUser({ role: 'editor', moduleAccessStates: {}, moduleAccessOverride: [] });
  const presetDecision = evaluateModuleAccess(editorPresetOnly, 'addNews', policy, { now });
  assert.equal(presetDecision.allowed, false);
  assert.equal(presetDecision.individualState, 'disabled');
  assert.equal(presetDecision.reasonCode, 'STAFF_ACCESS_DISABLED');
});

test('Shailesh receives one backend effective module result independent of Editor preset', async () => {
  const app = buildAccessApp();
  currentUser = makeUser({
    _id: STAFF_ID,
    email: 'shailesh@example.com',
    name: 'Shailesh Rathod',
    role: 'editor',
    roleName: 'Editor',
    staffId: 'NP-2026-0003',
    status: 'active',
    accountStatus: 'active',
    noExpiry: true,
    accessExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
    moduleAccessStates: {
      addNews: 'enabled',
      communityReporterQueue: 'enabled',
    },
    moduleAccessOverride: ['add_news', 'community_reporter_queue'],
  });
  Role.findOne = () => queryResult({
    name: 'Editor',
    slug: 'editor',
    moduleAccess: ['analytics'],
    specialRights: ['news_publish'],
  });
  siteSettingsDoc.adminModulePolicy = buildPolicy({
    addNews: 'available',
    communityReporterQueue: 'staff_locked',
    analytics: 'available',
  });
  const token = signToken({ sub: currentUser._id, email: currentUser.email, role: currentUser.role, name: currentUser.name });
  const shape = ({ visible, allowed, globalState, individualState, reasonCode }) => ({ visible, allowed, globalState, individualState, reasonCode });

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.deepEqual(shape(me.body.effectiveModuleAccess.addNews), { visible: true, allowed: true, globalState: 'available', individualState: 'enabled', reasonCode: 'ALLOWED' });
  assert.deepEqual(shape(me.body.effectiveModuleAccess.communityReporterQueue), { visible: true, allowed: false, globalState: 'staff_locked', individualState: 'enabled', reasonCode: 'GLOBAL_STAFF_LOCK' });
  assert.equal(me.body.effectiveModuleAccess.analytics.allowed, false);
  assert.equal(me.body.effectiveModuleAccess.analytics.reasonCode, 'STAFF_ACCESS_DISABLED');

  const directAddNews = await request(app).get('/api/access/can-access/add_news').set('Authorization', `Bearer ${token}`);
  assert.equal(directAddNews.status, 200);
  assert.equal(directAddNews.body.allowed, true);
  assert.equal(directAddNews.body.decision.reasonCode, 'ALLOWED');

  const directCommunity = await request(app).get('/api/access/can-access/community_reporter_queue').set('Authorization', `Bearer ${token}`);
  assert.equal(directCommunity.status, 200);
  assert.equal(directCommunity.body.allowed, false);
  assert.equal(directCommunity.body.decision.reasonCode, 'GLOBAL_STAFF_LOCK');

  const protectedAddNews = await request(app).get('/secure-add-news').set('Authorization', `Bearer ${token}`);
  assert.equal(protectedAddNews.status, 200);

  const protectedCommunity = await request(app).get('/secure-community-queue').set('Authorization', `Bearer ${token}`);
  assert.equal(protectedCommunity.status, 403);
});

test('Founder can read and update policy while Editor is blocked and invalid keys are rejected', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });
  const editorToken = signToken({ role: 'editor', email: 'editor@example.com', name: 'Editor' });

  const read = await request(app).get('/api/admin/safe-owner-zone/module-policy').set('Authorization', `Bearer ${founderToken}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.version, 7);
  assert.equal(read.body.policy.version, undefined);
  assert.equal(read.body.policy.modulePolicies.safeZone, 'founder_only');

  const blocked = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ auditReason: 'blocked update', modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(blocked.status, 403);

  const invalid = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'bad update', expectedVersion: 7, modulePolicies: { add_news: 'hidden', financeDesk: 'bad' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'MODULE_POLICY_VALIDATION_FAILED');
  assert.deepEqual(invalid.body.invalidKeys, ['add_news']);
  assert.deepEqual(invalid.body.invalidStateKeys, ['financeDesk']);

  const updated = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'lock finance during audit', expectedVersion: 7, modulePolicies: { financeDesk: 'staff_locked', safeZone: 'available' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.policy.modulePolicies.financeDesk, 'staff_locked');
  assert.equal(updated.body.policy.modulePolicies.safeZone, 'founder_only');
  assert.equal(updated.body.version, 8);
  assert.equal(updated.body.policy.version, undefined);
  const audit = auditDocs.find((doc) => doc.action === 'FOUNDER_MODULE_POLICY_UPDATED' && doc.meta?.affectedModuleKeys);
  assert.ok(audit);
  assert.equal(audit.meta.founderId, FOUNDER_ID);
  assert.equal(audit.meta.policyVersion, 8);
  assert.deepEqual(audit.meta.affectedModuleKeys.sort(), ['financeDesk', 'safeZone'].sort());
});

test('module policy write requires a positive expectedVersion and rejects generated stale values', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });

  const missing = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'missing version update', modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'MODULE_POLICY_VERSION_REQUIRED');

  const invalid = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'invalid version update', expectedVersion: 'not-a-version', modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'MODULE_POLICY_VERSION_INVALID');

  const generated = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'generated stale version update', expectedVersion: Date.now(), modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(generated.status, 409);
  assert.equal(generated.body.code, 'MODULE_POLICY_VERSION_CONFLICT');
  assert.equal(generated.body.currentVersion, 7);
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 7);
});

test('successful module policy save increments version and the second save must use the new version', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });

  const first = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'hide finance temporarily', expectedVersion: 7, modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 8);
  assert.equal(first.body.policy.modulePolicies.financeDesk, 'hidden');
  assert.equal(first.body.policy.modulePolicies.analytics, 'hidden');

  const second = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'restore analytics panel', expectedVersion: 8, modulePolicies: { analytics: 'available' } });
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 9);
  assert.equal(second.body.policy.modulePolicies.financeDesk, 'hidden');
  assert.equal(second.body.policy.modulePolicies.analytics, 'available');
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 9);
});

test('stale module policy writes cannot overwrite newer settings', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });

  const first = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'first writer hides finance', expectedVersion: 7, modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 8);

  const stale = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'stale writer reopens analytics', expectedVersion: 7, modulePolicies: { analytics: 'available' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'MODULE_POLICY_VERSION_CONFLICT');
  assert.equal(stale.body.currentVersion, 8);
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 8);
  assert.equal(siteSettingsDoc.adminModulePolicy.modulePolicies.financeDesk, 'hidden');
  assert.equal(siteSettingsDoc.adminModulePolicy.modulePolicies.analytics, 'hidden');
});

test('module policy preview uses expectedVersion and never mutates saved policy', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });
  const before = { ...siteSettingsDoc.adminModulePolicy.modulePolicies };

  const stale = await request(app)
    .post('/api/admin/safe-owner-zone/module-policy/preview')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ expectedVersion: 6, modulePolicies: { financeDesk: 'hidden' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'MODULE_POLICY_VERSION_CONFLICT');
  assert.deepEqual(siteSettingsDoc.adminModulePolicy.modulePolicies, before);

  const preview = await request(app)
    .post('/api/admin/safe-owner-zone/module-policy/preview')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ expectedVersion: 7, modulePolicies: { financeDesk: 'hidden', safeZone: 'available' } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.version, 7);
  assert.equal(preview.body.policy.modulePolicies.financeDesk, 'available');
  assert.equal(preview.body.preview.modulePolicies.financeDesk, 'hidden');
  assert.equal(preview.body.preview.modulePolicies.safeZone, 'founder_only');
  assert.deepEqual(siteSettingsDoc.adminModulePolicy.modulePolicies, before);
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 7);
});

test('bulk Founder-only restriction requires Founder, reason, version and confirmation', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });
  const editorToken = signToken({ role: 'editor', email: 'editor@example.com', name: 'Editor' });

  const editor = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${editorToken}`)
    .send({ auditReason: 'lock all modules', expectedVersion: 7, bulkAction: BULK_FOUNDER_ONLY_ACTION, confirmation: BULK_FOUNDER_ONLY_CONFIRMATION });
  assert.equal(editor.status, 403);

  const missingReason = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ expectedVersion: 7, bulkAction: BULK_FOUNDER_ONLY_ACTION, confirmation: BULK_FOUNDER_ONLY_CONFIRMATION });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.code, 'MODULE_POLICY_VALIDATION_FAILED');

  const stale = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'stale lock all modules', expectedVersion: 6, bulkAction: BULK_FOUNDER_ONLY_ACTION, confirmation: BULK_FOUNDER_ONLY_CONFIRMATION });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'MODULE_POLICY_VERSION_CONFLICT');
  assert.equal(stale.body.message, 'Founder Access Control settings changed since this page was loaded.');
  assert.equal(stale.body.currentVersion, 7);

  const missingConfirmation = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'lock all modules', expectedVersion: 7, bulkAction: BULK_FOUNDER_ONLY_ACTION });
  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.body.code, 'MODULE_POLICY_VALIDATION_FAILED');

  const beforeAccess = currentUser.moduleAccessOverride.slice();
  const res = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'lock all modules', expectedVersion: 7, bulkAction: BULK_FOUNDER_ONLY_ACTION, confirmation: BULK_FOUNDER_ONLY_CONFIRMATION });

  assert.equal(res.status, 200);
  assert.equal(res.body.bulkAction, BULK_FOUNDER_ONLY_ACTION);
  assert.equal(res.body.version, 8);
  assert.equal(Object.values(res.body.policy.modulePolicies).every((state) => state === 'founder_only'), true);
  assert.equal(res.body.policy.modulePolicies.safeZone, 'founder_only');
  assert.equal(res.body.affectedModuleKeys.includes('dashboard'), false);
  assert.equal(res.body.affectedModuleKeys.includes('myAccount'), false);
  assert.equal(res.body.affectedModuleKeys.includes('darkMode'), false);
  assert.equal(res.body.affectedModuleKeys.includes('logout'), false);
  assert.deepEqual(currentUser.moduleAccessOverride, beforeAccess);
});

test('policy persistence failure does not return success', async () => {
  const app = buildSafeZoneApp();
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });
  failSave = true;

  const res = await request(app)
    .put('/api/admin/safe-owner-zone/module-policy')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'simulate db failure', expectedVersion: 7, modulePolicies: { financeDesk: 'hidden' } });

  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
  assert.equal(siteSettingsDoc.adminModulePolicy.version, 7);
});

test('/auth/me and direct route authorization use latest effective access', async () => {
  const app = buildAccessApp();
  const token = signToken({ sub: currentUser._id, email: currentUser.email, role: currentUser.role });

  let me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.access.accessVersion, 0);
  assert.equal(me.body.effectiveModuleAccess.financeDesk.allowed, true);

  let direct = await request(app).get('/secure-finance').set('Authorization', `Bearer ${token}`);
  assert.equal(direct.status, 200);

  siteSettingsDoc.adminModulePolicy = buildPolicy({ financeDesk: 'hidden' });
  me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(me.body.effectiveModuleAccess.financeDesk.visible, false);
  assert.equal(me.body.effectiveModuleAccess.financeDesk.reasonCode, 'MODULE_HIDDEN');

  direct = await request(app).get('/secure-finance').set('Authorization', `Bearer ${token}`);
  assert.equal(direct.status, 403);
});

test('/auth/me returns 200 for no-expiry staff when role preset and optional access data are missing', async () => {
  const app = buildAccessApp();
  currentUser = makeUser({
    _id: STAFF_ID,
    email: 'minimal-staff@example.com',
    name: 'Minimal Staff',
    role: 'editor',
    noExpiry: true,
    accessExpiresAt: null,
  });
  delete currentUser.moduleAccessStates;
  delete currentUser.moduleAccessOverride;
  delete currentUser.specialRightsOverride;
  delete currentUser.taskRightsOverride;
  delete currentUser.accountControlRightsOverride;
  Role.findOne = () => queryResult(null);
  const token = signToken({ sub: currentUser._id, email: currentUser.email, role: currentUser.role, name: currentUser.name });

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, currentUser.email);
  assert.equal(me.body.user.noExpiry, true);
  assert.equal(me.body.effectiveModuleAccess.dashboard.allowed, true);
  assert.equal(me.body.effectiveModuleAccess.financeDesk.allowed, false);
});

test('/auth/me does not crash Founder session restore when optional policy lookup fails', async () => {
  const app = buildAccessApp();
  const token = signToken({ sub: FOUNDER_ID, role: 'founder', email: founderUser.email, name: founderUser.name });
  let policyLookups = 0;
  SiteSettings.findOne = async () => { policyLookups += 1; throw new Error('policy lookup unavailable'); };

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  assert.equal(me.status, 200);
  assert.equal(me.body.ok, true);
  assert.equal(me.body.user.role, 'founder');
  assert.equal(me.body.effectiveModuleAccess.safeZone.allowed, true);
  assert.equal(me.body.effectiveModuleAccess.financeDesk.allowed, true);
  assert.equal(me.body.access.modules.includes('safeZone'), true);
  assert.equal(policyLookups, 0);
  const bodyText = JSON.stringify(me.body);
  assert.equal(bodyText.includes('passwordHash'), false);
  assert.equal(bodyText.includes('resetPasswordToken'), false);
  assert.equal(bodyText.includes('accessToken'), false);
  assert.equal(bodyText.includes('refreshToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(me.body, 'token'), false);
});

test('staff module access update increments accessVersion and returns saved record', async () => {
  const adminTeamRoutes = require('../routes/adminTeam.routes');
  const app = express();
  app.use(express.json());
  app.use('/admin-api/admin/team', adminTeamRoutes);
  const founderToken = signToken({ sub: FOUNDER_ID, role: 'founder', email: 'founder@example.com', name: 'Founder' });

  const res = await request(app)
    .patch(`/admin-api/admin/team/access/staff/${currentUser._id}/modules`)
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ auditReason: 'grant finance desk', moduleAccessStates: { financeDesk: 'enabled', analytics: 'disabled' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.record.accessVersion, 1);
  assert.deepEqual(res.body.record.moduleAccessStates, { financeDesk: 'enabled', analytics: 'disabled' });
  assert.deepEqual(currentUser.moduleAccessOverride, ['finance_desk']);
  assert.equal(res.body.effectiveAccess, undefined);
  assert.equal(res.body.data.effectiveAccess.canonicalModules.financeDesk.allowed, true);
});

test('validatePolicyPatch rejects duplicate alias module keys', () => {
  const validation = validatePolicyPatch({ modulePolicies: { mediaLibrary: 'hidden', communityQueue: 'available' } });
  assert.deepEqual(validation.invalidKeys, ['mediaLibrary', 'communityQueue']);
});

test('individual access cannot override founder_only but works again when global policy is available', () => {
  const staff = makeUser({ moduleAccessOverride: ['add_news'] });
  const founderOnly = evaluateModuleAccess(staff, 'addNews', { modulePolicies: { addNews: 'founder_only' } });
  assert.equal(founderOnly.allowed, false);
  assert.equal(founderOnly.reasonCode, 'FOUNDER_ONLY');
  assert.deepEqual(staff.moduleAccessOverride, ['add_news']);

  const available = evaluateModuleAccess(staff, 'addNews', { modulePolicies: { addNews: 'available' } });
  assert.equal(available.allowed, true);
  assert.equal(available.reasonCode, 'ALLOWED');
});