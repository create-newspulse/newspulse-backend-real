const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const User = require('../models/User');

const ADMIN_SETTINGS_KEY = 'settings_center_admin';
const STAFF_EMAIL = 'staff@newspulse.ai';

function signAdminToken(overrides = {}) {
  return jwt.sign(
    { sub: 'staff-id', email: STAFF_EMAIL, role: 'admin', ...overrides },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = 1;
}

// requireAdminAuth resolves the user by email when the JWT `sub` isn't a valid ObjectId.
function stubAdminUser(t, role) {
  const prevFindOne = User.findOne;
  t.after(() => { User.findOne = prevFindOne; });
  User.findOne = () => ({
    lean: async () => ({ email: STAFF_EMAIL, role, isFounder: role === 'founder', status: 'active' }),
  });
}

function stubArticleAssistantSetting(t, enabledForStaff) {
  const prevFindOne = SystemSetting.findOne;
  t.after(() => { SystemSetting.findOne = prevFindOne; });

  SystemSetting.findOne = (filter) => ({
    lean: async () => {
      if (filter && filter.key !== ADMIN_SETTINGS_KEY) return null;
      if (enabledForStaff === undefined) return null; // field missing => default true
      return { key: ADMIN_SETTINGS_KEY, value: { adminPanel: { articleAssistantForStaff: enabledForStaff } } };
    },
  });
}

test('POST /api/assist/suggest: Founder + setting ON = allowed', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubArticleAssistantSetting(t, true);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /api/assist/suggest: Founder + setting OFF = allowed', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /api/assist/suggest: Staff + setting ON (or missing) = allowed', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'editor');
  stubArticleAssistantSetting(t, undefined);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'editor' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /api/assist/suggest: Staff + setting OFF = 403', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'editor');
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'editor' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Article Assistant is disabled for staff.');
});

test('POST /api/assist/suggest: unauthenticated request follows existing 401 auth behavior', async (t) => {
  stubDbReady(t);
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest')
    .send({ title: 'Hello world' });

  assert.equal(res.status, 401);
});

test('POST /api/assist/suggest: staff cannot bypass restriction by calling endpoint directly', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'reporter');
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'reporter' })}`)
    .send({ title: 'Bypass attempt', content: 'x' });

  assert.equal(res.status, 403);
});

test('POST /api/assist/suggest: existing suggestion response shape unchanged when allowed', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'editor');
  stubArticleAssistantSetting(t, true);

  const res = await request(app)
    .post('/api/assist/suggest')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'editor' })}`)
    .send({ title: 'Some Title', content: 'Body' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.version, 'v1-fallback');
  assert.deepEqual(res.body.data.input, { title: 'Some Title', content: 'Body' });
});

test('POST /api/assist/suggest/v2: Staff + setting OFF = 403', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'manager');
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest/v2')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'manager' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 403);
});

test('POST /api/assist/suggest/v2: Founder + setting OFF = allowed, response unchanged', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubArticleAssistantSetting(t, false);

  const res = await request(app)
    .post('/api/assist/suggest/v2')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ title: 'Hello world' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.version, 'v2-fallback');
});
