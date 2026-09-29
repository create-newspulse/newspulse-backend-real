const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
test.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
const mongoose = require('mongoose');
const User = require('../models/User');
const app = express();
app.use(express.json());
app.get('/admin', require('../middleware/adminAuth').requireAdminAuth, (_req, res) => res.json({ ok: true }));
app.get('/staff', require('../middleware/requireAuth').requireAuth, (_req, res) => res.json({ ok: true }));
const userId = '507f1f77bcf86cd799439011';
function credential(type = 'access', overrides = {}) {
  return jwt.sign({ sub: userId, role: 'founder', email: 'synthetic@example.invalid', type, tokenVersion: 0, ...overrides }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

test('privileged guards require a current account and never trust claims during database outages', async (context) => {
  const state = mongoose.connection.readyState;
  context.after(() => { mongoose.connection.readyState = state; });
  for (const route of ['/admin', '/staff']) {
    mongoose.connection.readyState = 0;
    assert.equal((await request(app).get(route).auth(credential(), { type: 'bearer' })).status, 503);
    assert.equal((await request(app).get(route).auth(credential('refresh'), { type: 'bearer' })).status, 401);
  }
  mongoose.connection.readyState = 1;
  let user = null;
  const query = () => ({ then: resolve => resolve(user), lean: async () => user });
  context.mock.method(User, 'findById', query);
  context.mock.method(User, 'findOne', query);
  for (const route of ['/admin', '/staff']) assert.equal((await request(app).get(route).auth(credential(), { type: 'bearer' })).status, 401);
  user = { _id: userId, role: 'founder', status: 'active', tokenVersion: 0 };
  for (const route of ['/admin', '/staff']) assert.equal((await request(app).get(route).auth(credential(), { type: 'bearer' })).status, 200);
});

test('refresh validates current status, rotates credentials once, and logout revokes access and refresh', async (context) => {
  const authRoutes = require('../routes/auth.routes');
  const state = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = state; });
  let user = { _id: userId, role: 'founder', status: 'active', accountStatus: 'active', tokenVersion: 0 };
  context.mock.method(User, 'findById', () => ({ then: resolve => resolve(user), lean: async () => user }));
  context.mock.method(User, 'findOneAndUpdate', async (filter) => {
    const version = typeof filter.tokenVersion === 'object' ? 0 : filter.tokenVersion;
    if (user.tokenVersion !== version) return null;
    user = { ...user, tokenVersion: version + 1 };
    return user;
  });
  context.mock.method(User, 'findByIdAndUpdate', async () => { user.tokenVersion += 1; return user; });
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  const fixture = express();
  fixture.use(express.json());
  fixture.use('/auth', authRoutes);
  for (const status of ['suspended', 'locked', 'disabled', 'archived']) {
    user.status = status;
    assert.equal((await request(fixture).post('/auth/refresh').send({ refreshToken: credential('refresh') })).status, 403, status);
  }
  user.status = 'active';
  user.loginAllowed = false;
  assert.equal((await request(fixture).post('/auth/refresh').send({ refreshToken: credential('refresh') })).status, 403);
  user.loginAllowed = true;
  const refreshed = await request(fixture).post('/auth/refresh').send({ refreshToken: credential('refresh') });
  assert.equal(refreshed.status, 200);
  assert.equal(jwt.decode(refreshed.body.refreshToken).tokenVersion, 1);
  assert.equal((await request(fixture).post('/auth/refresh').send({ refreshToken: credential('refresh') })).status, 401);
  assert.equal((await request(fixture).post('/auth/refresh').send({ refreshToken: refreshed.body.accessToken })).status, 401);
  assert.equal((await request(fixture).post('/auth/logout').auth(refreshed.body.accessToken, { type: 'bearer' })).status, 200);
  assert.equal((await request(app).get('/admin').auth(refreshed.body.accessToken, { type: 'bearer' })).status, 401);
  assert.equal((await request(fixture).post('/auth/refresh').send({ refreshToken: refreshed.body.refreshToken })).status, 401);
});

test('privacy service rejects forged workflow status and unverified identity before model access', async () => {
  const actions = require('../services/dpdpDataActions');
  for (const status of ['Verified', 'In Review', 'Pending Email Verification']) {
    const privacyRequest = { email: 'privacy@example.invalid', status };
    await assert.rejects(actions.searchMatchingDataForPrivacyRequest(privacyRequest), { code: 'DPDP_IDENTITY_UNVERIFIED' });
    await assert.rejects(actions.performPrivacyDataAction({ request: privacyRequest, action: 'delete', items: [] }), { code: 'DPDP_IDENTITY_UNVERIFIED' });
  }
});

test('admin OTP uses hashed one-use reset credentials, bounded attempts and password policy', async (context) => {
  const OtpToken = require('../models/OtpToken');
  const mailer = require('../lib/mailer');
  context.mock.method(mailer, 'sendMail', async () => { throw new Error('No external mail allowed'); });
  context.mock.method(mailer, 'getTransporter', () => null);
  const bcrypt = require('bcrypt');
  const code = crypto.randomInt(100000, 1000000).toString();
  const email = 'reset@example.invalid';
  let record = { _id: userId, email, purpose: 'admin_otp', codeHash: await bcrypt.hash(code, 4), expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), verificationAttempts: 0, used: false };
  const user = { _id: userId, email, status: 'active', tokenVersion: 0, save: async () => {} };
  context.mock.method(User, 'findOne', async () => user);
  context.mock.method(require('../models/ActivityLog'), 'create', async () => ({}));
  context.mock.method(OtpToken, 'findOneAndUpdate', async (filter, update) => {
    if (record.used || (filter.resetToken !== undefined && (record.resetToken || null) !== filter.resetToken)) return null;
    if (update.$inc) {
      assert.equal(filter.purpose, 'admin_otp');
      assert.equal(filter.$or[0].verificationAttempts.$lt, 5);
      if (record.verificationAttempts >= 5) return null;
      record.verificationAttempts += 1;
    }
    if (update.$set) Object.assign(record, update.$set);
    return { ...record };
  });
  context.mock.method(OtpToken, 'findOne', filter => ({ sort: async () => !record.used && filter.resetToken === record.resetToken ? { ...record } : null }));
  const fixture = express();
  fixture.use(express.json());
  fixture.use(require('../routes/authOtp'));
  const verified = await request(fixture).post('/verify').send({ email, code });
  assert.equal(verified.status, 200);
  assert.equal(record.resetToken, 'sha256:' + crypto.createHash('sha256').update(verified.body.resetToken).digest('hex'));
  assert.notEqual(record.resetToken, verified.body.resetToken);
  assert.equal((await request(fixture).post('/verify').send({ email, code })).status, 400);
  const payload = { email, resetToken: verified.body.resetToken, newPassword: 'short' };
  assert.equal((await request(fixture).post('/reset').send(payload)).status, 400);
  payload.newPassword = 'Synthetic!Password2048';
  assert.equal((await request(fixture).post('/reset').send(payload)).status, 200);
  assert.equal(user.tokenVersion, 1);
  assert.equal((await request(fixture).post('/reset').send(payload)).status, 400);
  record = { ...record, used: false, resetToken: null, verificationAttempts: 5 };
  assert.equal((await request(fixture).post('/verify').send({ email, code })).status, 400);
});

test('cookie writes require a trusted Origin while bearer clients remain supported', async () => {
  const { rejectUnsafeCookieAuth } = require('../lib/authRequestSecurity');
  const fixture = express();
  fixture.post('/write', (req, res) => { if (!rejectUnsafeCookieAuth(req, res)) res.sendStatus(204); });
  assert.equal((await request(fixture).post('/write').set('Cookie', 'np_admin_token=synthetic')).status, 403);
  assert.equal((await request(fixture).post('/write').set('Cookie', 'np_admin_token=synthetic').set('Origin', 'https://attacker.invalid')).status, 403);
  assert.equal((await request(fixture).post('/write').auth('synthetic', { type: 'bearer' })).status, 204);
});

test('privacy module grants, not role names or typed confirmation, authorize staff', async (context) => {
  const store = require('../services/privacyRequestStore');
  context.mock.method(store, 'listPrivacyRequests', async () => []);
  const { adminRouter } = require('../routes/privacy.routes');
  const SiteSettings = require('../models/SiteSettings');
  const state = mongoose.connection.readyState;
  const previousDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.readyState = state; mongoose.connection.db = previousDb; });
  const user = { _id: userId, role: 'editor', status: 'active', tokenVersion: 0, moduleAccessStates: {} };
  context.mock.method(User, 'findById', () => ({ lean: async () => user }));
  context.mock.method(SiteSettings, 'findOne', async () => ({ adminModulePolicy: { version: 1, modulePolicies: { dpdpCompliance: 'available' } } }));
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  const fixture = express();
  fixture.use(express.json(), adminRouter);
  assert.equal((await request(fixture).get('/privacy-requests').auth(credential(), { type: 'bearer' })).status, 403);
  assert.equal((await request(fixture).post('/privacy-requests/fake/data-action').auth(credential(), { type: 'bearer' }).send({ founderConfirmation: 'DELETE' })).status, 403);
  user.moduleAccessStates.dpdpCompliance = 'enabled';
  assert.equal((await request(fixture).get('/privacy-requests').auth(credential(), { type: 'bearer' })).status, 200);
  user.role = 'founder';
  user.moduleAccessStates = {};
  assert.equal((await request(fixture).get('/privacy-requests').auth(credential(), { type: 'bearer' })).status, 200);
});

test('privacy erasure fails on private media errors, excludes unverified phone and retains editorial records', async (context) => {
  const actions = require('../services/dpdpDataActions');
  const CommunitySubmission = require('../models/CommunitySubmission');
  const storage = require('../services/reporterDocumentStorage');
  const privacyRequest = { requestId: 'synthetic', email: 'privacy@example.invalid', mobile: '1234567890', status: 'Verified', verifiedAt: new Date() };
  const record = { _id: userId, email: privacyRequest.email, reporterEmail: privacyRequest.email, phone: privacyRequest.mobile, reporterDocumentId: crypto.randomUUID() + '.pdf', status: 'PUBLISHED', linkedArticleId: userId };
  context.mock.method(CommunitySubmission, 'findById', () => ({ select() { return this; }, session() { return this; }, lean: async () => ({ ...record }) }));
  const session = { withTransaction: async operation => operation(), endSession: async () => {} };
  context.mock.method(mongoose, 'startSession', async () => session);
  const update = context.mock.method(CommunitySubmission, 'updateOne', async (_filter, changes, options) => {
    assert.equal(options.session, session);
    assert.equal(changes.$set.reporterDocumentId, null);
    assert.equal(changes.$set.reporterAccountId, null);
    assert.equal(changes.$set.ipAddress, null);
    return { matchedCount: 1 };
  });
  const input = { request: privacyRequest, action: 'delete', items: [{ source: 'community_reporter_requests', recordId: userId }], newStatus: 'Completed' };
  await assert.rejects(actions.performPrivacyDataAction(input), { code: 'DPDP_EDITORIAL_RECORD_RETAINED' });
  input.action = 'anonymize';
  input.items.push({ ...input.items[0] });
  record.email = record.reporterEmail = 'different@example.invalid';
  await assert.rejects(actions.performPrivacyDataAction(input), { code: 'DPDP_IDENTITY_MISMATCH' });
  record.email = record.reporterEmail = privacyRequest.email;
  const deletion = context.mock.method(storage, 'deleteReporterDocument', async () => { throw new Error('Provider unavailable'); });
  await assert.rejects(actions.performPrivacyDataAction(input), { code: 'DPDP_MEDIA_DELETE_FAILED' });
  assert.equal(update.mock.calls.length, 0);
  deletion.mock.mockImplementation(async () => ({ deleted: true }));
  const result = await actions.performPrivacyDataAction(input);
  assert.equal(result.newStatus, 'In Review');
  assert.equal(result.results[0].outcome, 'structured_private_identity_redacted');
  assert.equal(update.mock.calls.length, 1);
});

test('security diagnostics omit credentials, identity and message payloads', () => {
  const { safeSecurityLog } = require('../lib/securityLog');
  assert.deepEqual(safeSecurityLog({ statusCode: 400, provider: 'smtp', email: 'test@example.invalid', ip: '127.0.0.1', code: '123456', otp: '123456', password: 'synthetic', resetToken: 'synthetic', cookie: 'synthetic', authorization: 'synthetic', text: 'private', message: 'private', requestBody: {} }), { statusCode: 400, provider: 'smtp' });
});

test('explicit reporter contact erasure clears linked private identity and profile contact methods in one transaction', async (context) => {
  const actions = require('../services/dpdpDataActions');
  const ReporterContact = require('../models/ReporterContact');
  const CommunitySubmission = require('../models/CommunitySubmission');
  const ReporterProfile = require('../models/ReporterProfile');
  const email = 'privacy@example.invalid';
  const contact = { _id: userId, email, reporterType: 'community', portalAuthVersion: 2 };
  const query = value => ({ session() { return this; }, select() { return this; }, lean: async () => value });
  context.mock.method(ReporterContact, 'findById', () => query(contact));
  context.mock.method(CommunitySubmission, 'find', () => query([{ _id: userId, reporterEmail: email }]));
  const session = { withTransaction: async operation => operation(), endSession: async () => {} };
  context.mock.method(mongoose, 'startSession', async () => session);
  const submissionUpdate = context.mock.method(CommunitySubmission, 'updateOne', async (_filter, change, options) => {
    assert.equal(options.session, session);
    assert.equal(change.$set.reporterAccountId, null);
    assert.equal(change.$set.contact.canContactForFutureStories, false);
    return { matchedCount: 1 };
  });
  const profileUpdate = context.mock.method(ReporterProfile, 'updateMany', async (_filter, change, options) => {
    assert.equal(options.session, session);
    assert.equal(change.$set.primaryPhone, null);
    assert.equal(change.$set.primaryEmail, null);
    return { modifiedCount: 1 };
  });
  context.mock.method(require('../models/ReporterStoryLink'), 'deleteMany', async () => ({ deletedCount: 1 }));
  context.mock.method(ReporterContact, 'updateOne', async (_filter, change, options) => {
    assert.equal(options.session, session);
    assert.equal(change.$set.portalAccessEnabled, false);
    assert.equal(change.$set.portalAuthVersion, 3);
    assert.deepEqual(change.$set.directoryManualOverrides, {});
    return { matchedCount: 1 };
  });
  const result = await actions.performPrivacyDataAction({ request: { email, status: 'Verified', verifiedAt: new Date() }, action: 'anonymize', items: [{ source: 'community_reporter_contacts', recordId: userId }], newStatus: 'Completed' });
  assert.equal(result.newStatus, 'In Review');
  assert.equal(submissionUpdate.mock.calls.length, 1);
  assert.equal(profileUpdate.mock.calls.length, 1);
});

test('production privacy store cannot fall back to filesystem during database outage', async (context) => {
  const env = process.env.NODE_ENV;
  const state = mongoose.connection.readyState;
  process.env.NODE_ENV = 'production';
  mongoose.connection.readyState = 0;
  context.after(() => { process.env.NODE_ENV = env; mongoose.connection.readyState = state; });
  const read = context.mock.method(require('node:fs'), 'readFileSync', () => { throw new Error('Unexpected filesystem read'); });
  await assert.rejects(require('../services/privacyRequestStore').listPrivacyRequests(), /Privacy database unavailable/);
  assert.equal(read.mock.calls.length, 0);
});

test('public privacy intake and verification keep tokens hashed and out of responses', async (context) => {
  const store = require('../services/privacyRequestStore');
  const emailService = require('../lib/emailService');
  let stored;
  let mail;
  context.mock.method(store, 'createPrivacyRequest', async payload => { stored = payload; return { requestId: payload.requestId }; });
  context.mock.method(store, 'verifyPrivacyRequestByTokenHash', async hash => {
    if (hash !== stored.verificationTokenHash) return null;
    stored = { ...stored, verificationTokenHash: null, status: 'Verified', verifiedAt: new Date() };
    return { request: stored, oldStatus: 'Pending Email Verification', newStatus: 'Verified' };
  });
  context.mock.method(store, 'createDpdpAuditLog', async () => ({}));
  context.mock.method(emailService, 'getPrivacyTransporter', () => ({ sendMail: async payload => { mail = payload; } }));
  context.mock.method(emailService, 'getPrivacyEmailConfig', () => ({ fromAddress: 'test@example.invalid' }));
  const modulePath = require.resolve('../controllers/privacyRequestController');
  const previous = require.cache[modulePath];
  delete require.cache[modulePath];
  context.after(() => { require.cache[modulePath] = previous; });
  const controller = require(modulePath);
  const fixture = express();
  fixture.use(express.json());
  fixture.post('/request', controller.submitPrivacyRequest);
  fixture.get('/verify/:token', controller.verifyPrivacyRequest);
  const response = await request(fixture).post('/request').send({ fullName: 'Synthetic Requester', email: 'privacy@example.invalid', requestType: 'access', message: 'Please provide the personal information associated with my account.' });
  assert.equal(response.status, 201);
  assert.equal(stored.status, 'Pending Email Verification');
  const verificationUrl = new URL(mail.text.trim().split('\n').at(-1));
  const token = verificationUrl.pathname.split('/').at(-1);
  assert.equal(stored.verificationTokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(response.body).includes(token), false);
  assert.equal((await request(fixture).get('/verify/' + token)).status, 200);
  assert.ok(stored.verifiedAt);
  assert.equal((await request(fixture).get('/verify/' + token)).status, 400);
});

test('production admin OTP never echoes codes even with the development flag enabled', async (context) => {
  const mailer = require('../lib/mailer');
  const OtpToken = require('../models/OtpToken');
  const envKeys = ['NODE_ENV', 'OTP_DEV_ECHO', 'OTP_ALLOW_ANY', 'EMAIL_MODE'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: 'production', OTP_DEV_ECHO: '1', OTP_ALLOW_ANY: '1', EMAIL_MODE: 'smtp' });
  context.after(() => { for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const email = 'production-test@example.invalid';
  context.mock.method(User, 'findOne', async () => ({ email, status: 'active' }));
  context.mock.method(OtpToken, 'updateMany', async () => ({}));
  context.mock.method(OtpToken, 'create', async payload => { assert.equal(payload.purpose, 'admin_otp'); assert.equal(payload.verificationAttempts, 0); return payload; });
  context.mock.method(require('../models/ActivityLog'), 'create', async () => ({}));
  context.mock.method(mailer, 'getTransporter', () => ({}));
  let mailedCode;
  context.mock.method(mailer, 'sendMail', async payload => { mailedCode = payload.text.match(/\b\d{6}\b/)[0]; return { accepted: [email] }; });
  const modulePath = require.resolve('../routes/authOtp');
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  context.after(() => { require.cache[modulePath] = cached; });
  const fixture = express();
  fixture.use(express.json(), require(modulePath));
  const response = await request(fixture).post('/request').send({ email });
  assert.equal(response.status, 200);
  assert.ok(mailedCode);
  assert.equal(Object.hasOwn(response.body, 'devCode'), false);
  assert.equal(JSON.stringify(response.body).includes(mailedCode), false);
});