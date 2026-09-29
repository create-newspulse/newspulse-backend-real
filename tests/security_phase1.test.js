const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.FOUNDER_EMAIL = 'founder@example.invalid';
test.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));

const mongoose = require('mongoose');
const User = require('../models/User');
const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');
const app = express();
app.get('/internal', requireAdminAuth, (req, res) => res.json({ role: req.admin.role }));
app.get('/founder', requireFounderAuth, (req, res) => res.json({ role: req.admin.role }));
app.use('/legacy', require('../newspulse-backend-real-main/routes/adminAuth'));
app.use('/threat', require('../routes/adminThreatRoutes'));
app.get('/owner', require('../middleware/requireOwnerKey').requireOwnerKey, (_req, res) => res.json({ ok: true }));
app.get('/staff', require('../middleware/requireAuth').requireAuth, (_req, res) => res.json({ ok: true }));
app.get('/queue', require('../middleware/adminAuth').requireAdminModule('communityReporterQueue'), (_req, res) => res.json({ items: [] }));
const backend = require('../server');

function signedToken(role = 'founder', overrides = {}, secret = process.env.JWT_SECRET) {
  return jwt.sign({ sub: '507f1f77bcf86cd799439011', role, email: 'founder@example.invalid', type: 'access', ...overrides }, secret, { expiresIn: '5m' });
}

test('unsigned identity cookies and tokens cannot authenticate or grant Founder access', async () => {
  for (const endpoint of ['/internal', '/founder']) {
    for (const cookie of ['np_admin', 'np_admin_email', 'np_admin_session', 'np_admin_access']) {
      const response = await request(app).get(endpoint).set('Cookie', cookie + '=founder@example.invalid');
      assert.equal(response.status, 401);
    }
    for (const token of ['founder@example.invalid', 'np.' + Buffer.from('founder@example.invalid:1').toString('base64'), 'access.unverified']) {
      assert.equal((await request(app).get(endpoint).auth(token, { type: 'bearer' })).status, 401);
    }
  }
});

test('signed Founder, admin and staff credentials retain bearer and cookie access', async () => {
  for (const role of ['founder', 'admin', 'editor', 'reporter', 'intern']) {
    const token = signedToken(role);
    assert.equal((await request(app).get('/internal').auth(token, { type: 'bearer' })).status, 200);
    for (const cookie of ['np_admin_token', 'np_token', 'token']) {
      assert.equal((await request(app).get('/internal').set('Cookie', cookie + '=' + token)).status, 200);
    }
    assert.equal((await request(app).get('/founder').auth(token, { type: 'bearer' })).status, role === 'founder' ? 200 : 403);
  }
});

test('missing, incorrect, expired and non-access credentials fail closed', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const validToken = signedToken();
  try {
    delete process.env.JWT_SECRET;
    assert.equal((await request(app).get('/internal').auth(validToken, { type: 'bearer' })).status, 500);
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
  const invalidTokens = [
    signedToken('founder', {}, crypto.randomBytes(32).toString('hex')),
    signedToken('founder', { type: 'refresh' }),
    signedToken('founder', { typ: 'refresh' }),
    jwt.sign({ role: 'founder' }, originalSecret, { expiresIn: -1 }),
  ];
  for (const token of invalidTokens) {
    assert.equal((await request(app).get('/internal').auth(token, { type: 'bearer' }).set('Cookie', 'np_admin=founder@example.invalid')).status, 401);
  }
  assert.equal((await request(app).get('/internal').set('Cookie', 'np_admin_token=%ZZ')).status, 401);
});

test('persisted account role controls Founder authorization, not the email or stale role claim', async (context) => {
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previousState; });
  context.mock.method(User, 'findById', () => ({ lean: async () => ({ _id: '507f1f77bcf86cd799439011', role: 'editor', email: 'founder@example.invalid', status: 'active', accountStatus: 'active', tokenVersion: 0 }) }));
  assert.equal((await request(app).get('/founder').auth(signedToken(), { type: 'bearer' })).status, 403);
});

test('legacy session probe rejects unsigned identities and returns the authenticated role', async () => {
  for (const token of ['np.unverified', 'access.unverified']) {
    const response = await request(app).get('/legacy/session').auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: false, user: null });
  }
  const response = await request(app).get('/legacy/session').auth(signedToken('editor'), { type: 'bearer' });
  assert.equal(response.body.success, true);
  assert.equal(response.body.user.role, 'editor');
});

test('adjacent active guards reject unsigned identities, refresh tokens and missing signing keys', async () => {
  assert.equal((await request(app).get('/threat/threat-stats').set('Cookie', 'np_admin=founder@example.invalid')).status, 401);
  assert.equal((await request(app).get('/threat/threat-stats').auth(signedToken(), { type: 'bearer' })).status, 200);
  assert.equal((await request(app).get('/staff').auth(signedToken('editor'), { type: 'bearer' })).status, 200);
  assert.equal((await request(app).get('/staff').auth(signedToken('editor', { type: 'refresh' }), { type: 'bearer' })).status, 401);
  const originalSecret = process.env.JWT_SECRET;
  const ownerToken = jwt.sign({ type: 'owner_key', sub: 'founder' }, originalSecret, { expiresIn: '5m' });
  assert.equal((await request(app).get('/owner').set('Cookie', 'owner_key=' + ownerToken)).status, 200);
  try {
    delete process.env.JWT_SECRET;
    assert.equal((await request(app).get('/owner').set('Cookie', 'owner_key=' + ownerToken)).status, 500);
    assert.equal((await request(backend).post('/api/owner/passkey/auth/verify').auth(ownerToken, { type: 'bearer' }).send({})).status, 500);
  } finally {
    process.env.JWT_SECRET = originalSecret;
  }
});

test('queue policy denies anonymous and unassigned staff while allowing Founder', async () => {
  assert.equal((await request(app).get('/queue')).status, 401);
  assert.equal((await request(app).get('/queue').auth(signedToken('reporter'), { type: 'bearer' })).status, 403);
  assert.equal((await request(app).get('/queue').auth(signedToken(), { type: 'bearer' })).status, 200);
});

test('persisted staff grants and Founder module locks govern queue access', async (context) => {
  const previousState = mongoose.connection.readyState;
  const previousDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.readyState = previousState; mongoose.connection.db = previousDb; });
  const user = { _id: '507f1f77bcf86cd799439011', role: 'editor', status: 'active', tokenVersion: 0, moduleAccessStates: { communityReporterQueue: 'enabled' } };
  const settings = { adminModulePolicy: { version: 1, modulePolicies: { communityReporterQueue: 'available' } } };
  context.mock.method(User, 'findById', () => ({ lean: async () => user }));
  context.mock.method(require('../models/SiteSettings'), 'findOne', async () => settings);
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  assert.equal((await request(app).get('/queue').auth(signedToken('editor'), { type: 'bearer' })).status, 200);
  user.moduleAccessStates.communityReporterQueue = 'disabled';
  assert.equal((await request(app).get('/queue').auth(signedToken('editor'), { type: 'bearer' })).status, 403);
  user.moduleAccessStates.communityReporterQueue = 'enabled';
  settings.adminModulePolicy.modulePolicies.communityReporterQueue = 'staff_locked';
  assert.equal((await request(app).get('/queue').auth(signedToken('editor'), { type: 'bearer' })).status, 403);
});

test('mounted internal queue and media list aliases reject anonymous and unassigned users', async () => {
  const routes = [
    '/api/community-reporter/queue',
    ...['/api/admin', '/admin-api/admin', '/admin-api/api/admin', '/admin'].map(prefix => prefix + '/community-reporter/queue'),
    ...['/api/admin/community', '/admin-api/admin/community', '/admin-api/api/admin/community', '/api/admin/community-reporter', '/admin-api/admin/community-reporter', '/admin-api/api/admin/community-reporter', '/admin/community-reporter', '/admin/community'].map(prefix => prefix + '/submissions'),
    '/api/admin/community-reporter/youth-pulse',
    '/api/admin/community-reporter/network/queues/unresolved',
    '/api/admin/community/reporter-contacts',
    '/api/uploads', '/admin-api/uploads', '/admin-api/api/uploads',
    '/api/media/items', '/api/admin/media/items', '/admin-api/media/items', '/admin-api/api/media/items',
  ];
  for (const route of routes) {
    assert.equal((await request(backend).get(route)).status, 401, route);
    assert.equal((await request(backend).get(route).auth(signedToken('reporter'), { type: 'bearer' })).status, 403, route);
  }
  const queue = await request(backend).get('/api/admin/community-reporter/queue').auth(signedToken(), { type: 'bearer' });
  assert.equal(queue.status, 200);
  assert.ok(Array.isArray(queue.body.items));
  assert.ok(queue.body.meta);
});

test('all mounted session aliases reject prefix shortcuts and preserve signed identities', async () => {
  for (const prefix of ['/admin-auth', '/api/admin-auth', '/admin-api/admin-auth', '/admin-api/api/admin-auth']) {
    const denied = await request(backend).get(prefix + '/session').auth('access.unverified', { type: 'bearer' });
    assert.equal(denied.body.success, false, prefix);
    const allowed = await request(backend).get(prefix + '/session').auth(signedToken('editor'), { type: 'bearer' });
    assert.equal(allowed.body.user.role, 'editor', prefix);
  }
});

test('persisted suspension, login disablement and token revocation block signed credentials', async (context) => {
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previousState; });
  const user = { _id: '507f1f77bcf86cd799439011', role: 'editor', status: 'active', accountStatus: 'active', tokenVersion: 0 };
  context.mock.method(User, 'findById', () => ({ lean: async () => user }));
  user.status = user.accountStatus = 'suspended';
  assert.equal((await request(app).get('/internal').auth(signedToken(), { type: 'bearer' })).status, 403);
  user.status = user.accountStatus = 'active';
  user.loginAllowed = false;
  const disabled = await request(app).get('/internal').auth(signedToken(), { type: 'bearer' });
  assert.equal(disabled.status, 403);
  assert.deepEqual(disabled.body, { ok: false, success: false, status: 403, code: 'LOGIN_DISABLED', message: 'Login disabled' });
  user.loginAllowed = true;
  user.tokenVersion = 1;
  assert.equal((await request(app).get('/internal').auth(signedToken(), { type: 'bearer' })).status, 401);
});

test('authorized upload listings retain their DTO and denied requests never query media', async (context) => {
  const Media = require('../models/Media');
  let queries = 0;
  context.mock.method(Media, 'find', () => {
    queries += 1;
    return { sort: () => ({ lean: async () => [] }) };
  });
  context.mock.method(Media, 'countDocuments', async () => 0);
  context.mock.method(require('node:fs'), 'mkdirSync', () => undefined);
  context.mock.method(require('node:fs'), 'accessSync', () => undefined);
  for (const route of ['/api/uploads', '/admin-api/uploads', '/admin-api/api/uploads']) {
    const before = queries;
    assert.equal((await request(backend).get(route + '?includeDeleted=1')).status, 401);
    assert.equal(queries, before);
    const response = await request(backend).get(route + '?includeDeleted=1').auth(signedToken(), { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.items, []);
    assert.equal(response.body.data.counts.all, 0);
    assert.equal(queries, before + 1);
  }
});

test('bulk media usage applies the media policy while preserving authorized response contracts', async (context) => {
  const previousState = mongoose.connection.readyState;
  const previousDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.readyState = previousState; mongoose.connection.db = previousDb; });
  const user = { _id: '507f1f77bcf86cd799439011', role: 'founder', status: 'active', tokenVersion: 0, moduleAccessStates: { media: 'enabled' } };
  context.mock.method(User, 'findById', () => ({ lean: async () => user }));
  context.mock.method(require('../models/SiteSettings'), 'findOne', async () => ({ adminModulePolicy: { version: 1, modulePolicies: { media: 'available' } } }));
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  const Media = require('../models/Media');
  let mediaQueries = 0;
  context.mock.method(Media, 'findById', async () => { mediaQueries += 1; return null; });
  context.mock.method(Media, 'findOne', async () => null);
  const mediaId = '507f1f77bcf86cd799439022';
  const expected = { ok: true, success: true, results: [{ mediaId, isUsed: false, usageCount: 0, usages: [], missing: true }] };
  for (const prefix of ['/api/media', '/api/admin/media', '/admin-api/media', '/admin-api/api/media']) {
    const endpoint = prefix + '/bulk-usage-check';
    const before = mediaQueries;
    const anonymous = await request(backend).post(endpoint).send({ ids: [mediaId] });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, 'UNAUTHORIZED');
    user.role = 'editor';
    user.moduleAccessStates.media = 'disabled';
    assert.equal((await request(backend).post(endpoint).auth(signedToken('editor'), { type: 'bearer' }).send({ ids: [mediaId] })).status, 403);
    assert.equal(mediaQueries, before);
    for (const role of ['founder', 'editor']) {
      user.role = role;
      user.moduleAccessStates.media = role === 'founder' ? 'disabled' : 'enabled';
      const response = await request(backend).post(endpoint).auth(signedToken(role), { type: 'bearer' }).send({ ids: [mediaId] });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, expected);
    }
  }
});

test('settings, editorial mutations and CRM writes retain their registered signed-auth guards', async () => {
  const cases = [
    ['../routes/adminCommunity', 'get', '/settings/community-reporter'],
    ['../routes/adminCommunity', 'put', '/settings/community-reporter'],
    ['../routes/adminCommunity', 'patch', '/submissions/:id/status'],
    ['../routes/adminCommunity', 'patch', '/youth-pulse/submissions/:id/editorial'],
    ['../routes/adminCommunityReporter', 'post', '/submissions/:id/decision'],
    ['../routes/adminCommunityReporter', 'post', '/stories/:storyId/restore'],
    ['../routes/adminContributorNetwork.routes', 'post', '/profiles/:profileId/notes'],
    ['../routes/adminContributorNetwork.routes', 'post', '/profiles/:profileId/tasks'],
  ];
  for (const [modulePath, method, routePath] of cases) {
    const router = require(modulePath);
    const registration = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]);
    assert.ok(registration, routePath);
    const middleware = registration.route.stack.slice(0, -1).map(layer => layer.handle);
    assert.ok(middleware.includes(requireAdminAuth), routePath);
    const fixture = express();
    fixture[method](routePath, ...middleware, (req, res) => res.json({ reachedHandler: true, role: req.admin.role }));
    const endpoint = routePath.replace(/:[^/]+/g, '507f1f77bcf86cd799439022');
    assert.equal((await request(fixture)[method](endpoint)).status, 401, routePath);
    const response = await request(fixture)[method](endpoint).auth(signedToken('editor'), { type: 'bearer' });
    assert.equal(response.status, 200, routePath);
    assert.deepEqual(response.body, { reachedHandler: true, role: 'editor' });
  }
});

test('all internal GET registrations retain queue access while unrelated writes retain prior guards', async () => {
  const modules = ['../routes/adminCommunity', '../routes/adminCommunityReporter', '../routes/adminContributorNetwork.routes'];
  for (const modulePath of modules) {
    for (const layer of require(modulePath).stack.filter(entry => entry.route)) {
      const route = layer.route;
      if (route.methods.get && route.path !== '/settings/community-reporter') {
        const fixture = express();
        fixture.get(route.path, ...route.stack.slice(0, -1).map(entry => entry.handle), (_req, res) => res.json({ reachedHandler: true }));
        const endpoint = route.path.replace(/:[^/]+/g, '507f1f77bcf86cd799439022');
        assert.equal((await request(fixture).get(endpoint).auth(signedToken('editor'), { type: 'bearer' })).status, 403, modulePath + route.path);
        assert.equal((await request(fixture).get(endpoint).auth(signedToken(), { type: 'bearer' })).status, 200, modulePath + route.path);
      } else {
        const previousGuard = require('../middleware/adminAuth').requireFounderOrAdmin;
        assert.ok(route.stack.some(entry => entry.handle === requireAdminAuth || entry.handle === previousGuard), modulePath + route.path);
      }
    }
  }
});