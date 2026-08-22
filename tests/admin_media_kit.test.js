process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-media-kit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const User = require('../models/User');
const AdSettings = require('../models/AdSettings');
const AuditLog = require('../models/AuditLog');
const { buildSlotEnabledDefaults } = require('../src/constants/adSlots');
const app = require('../server');

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeUser(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439101',
    email: overrides.email || 'staff@example.com',
    name: overrides.name || 'Staff',
    role: overrides.role || 'reporter',
    permissions: overrides.permissions || [],
    moduleAccessOverride: overrides.moduleAccessOverride || [],
    specialRightsOverride: overrides.specialRightsOverride || [],
    status: 'active',
    accountStatus: 'active',
    loginAllowed: true,
    tokenVersion: 0,
    noExpiry: false,
    isFounder: overrides.role === 'founder',
    isProtected: overrides.role === 'founder',
    ...overrides,
  };
}

function stubAuthenticatedUser(t, user) {
  const originalReadyState = mongoose.connection.readyState;
  const originalDb = mongoose.connection.db;
  const originalFindById = User.findById;
  const originalFindOne = User.findOne;
  const originalAdSettingsFindByIdAndUpdate = AdSettings.findByIdAndUpdate;
  const originalAdSettingsUpdateOne = AdSettings.updateOne;
  const originalAuditLogCreate = AuditLog.create;

  t.after(() => {
    mongoose.connection.readyState = originalReadyState;
    mongoose.connection.db = originalDb;
    User.findById = originalFindById;
    User.findOne = originalFindOne;
    AdSettings.findByIdAndUpdate = originalAdSettingsFindByIdAndUpdate;
    AdSettings.updateOne = originalAdSettingsUpdateOne;
    AuditLog.create = originalAuditLogCreate;
  });

  mongoose.connection.readyState = 1;
  mongoose.connection.db = { collection: () => ({}) };

  User.findById = (id) => ({
    lean: async () => (String(id) === String(user._id) ? user : null),
  });
  User.findOne = (filter) => ({
    lean: async () => (String(filter?.email || '').toLowerCase() === String(user.email || '').toLowerCase() ? user : null),
  });

  AdSettings.findByIdAndUpdate = () => ({
    lean: async () => ({
      _id: 'global',
      slotEnabled: buildSlotEnabledDefaults(false, {
        HOME_728x90: true,
        HOME_LEFT_300x250: true,
        ARTICLE_INLINE: true,
      }),
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    }),
  });
  AdSettings.updateOne = async () => ({ acknowledged: true });
  AuditLog.create = async () => ({ ok: true });
}

test('GET /api/admin/media-kit returns 401 without auth', async () => {
  const res = await request(app).get('/api/admin/media-kit');

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('Founder can access protected media kit through canonical route', async (t) => {
  const founder = makeUser({
    _id: '507f1f77bcf86cd799439111',
    email: 'kiran@newspulse.co.in',
    name: 'Founder',
    role: 'founder',
    staffId: 'NP-FND-0001',
    isFounder: true,
    isProtected: true,
    noExpiry: true,
  });
  stubAuthenticatedUser(t, founder);

  const res = await request(app)
    .get('/api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(founder)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.title, 'News Pulse Media Kit');
  assert.equal(res.body.data.status, 'internal');
  assert.equal(res.body.data.confidential, true);
  assert.equal(res.body.data.contactEmail, 'ads@newspulse.co.in');
  assert.equal(res.body.data.metrics.status, 'Analytics not connected');
  assert.ok(Array.isArray(res.body.data.sections));
  assert.ok(Array.isArray(res.body.data.placements));
  assert.equal(res.body.data.placements.some((placement) => placement.slot === 'HOME_728x90'), true);
});

test('Founder can access protected media kit through admin-api compatibility route', async (t) => {
  const founder = makeUser({
    _id: '507f1f77bcf86cd799439112',
    email: 'kiran@newspulse.co.in',
    name: 'Founder',
    role: 'founder',
    staffId: 'NP-FND-0001',
    isFounder: true,
    isProtected: true,
  });
  stubAuthenticatedUser(t, founder);

  const res = await request(app)
    .get('/admin-api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(founder)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('Ads and Revenue Growth Manager can view protected media kit', async (t) => {
  const adsManager = makeUser({
    _id: '507f1f77bcf86cd799439113',
    email: 'ads-manager@example.com',
    name: 'Ads Manager',
    role: 'ads & revenue growth manager',
  });
  stubAuthenticatedUser(t, adsManager);

  const res = await request(app)
    .get('/api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(adsManager)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('Staff with explicit media_kit_view right can view protected media kit', async (t) => {
  const staff = makeUser({
    _id: '507f1f77bcf86cd799439114',
    email: 'growth-staff@example.com',
    name: 'Growth Staff',
    role: 'reporter',
    specialRightsOverride: ['media_kit_view'],
  });
  stubAuthenticatedUser(t, staff);

  const res = await request(app)
    .get('/api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(staff)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('Staff with explicit media_kit_manage right can view protected media kit', async (t) => {
  const staff = makeUser({
    _id: '507f1f77bcf86cd799439116',
    email: 'media-kit-manager@example.com',
    name: 'Media Kit Manager',
    role: 'reporter',
    specialRightsOverride: ['media_kit_manage'],
  });
  stubAuthenticatedUser(t, staff);

  const res = await request(app)
    .get('/api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(staff)}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('Reporter without media kit right is forbidden', async (t) => {
  const reporter = makeUser({
    _id: '507f1f77bcf86cd799439115',
    email: 'reporter@example.com',
    name: 'Reporter',
    role: 'reporter',
  });
  stubAuthenticatedUser(t, reporter);

  const res = await request(app)
    .get('/api/admin/media-kit')
    .set('Authorization', `Bearer ${signToken(reporter)}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('No public media kit API is exposed', async () => {
  const publicApiRes = await request(app).get('/api/media-kit');
  const publicSettingsRes = await request(app).get('/api/public/media-kit');

  assert.equal(publicApiRes.status, 404);
  assert.equal(publicSettingsRes.status, 404);
});