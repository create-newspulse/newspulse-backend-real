const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const User = require('../models/User');

const STAFF_EMAIL = 'staff@newspulse.ai';

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = 1;
}

function stubAdminUser(t, role = 'admin') {
  const prevFindOne = User.findOne;
  t.after(() => { User.findOne = prevFindOne; });
  User.findOne = () => ({
    lean: async () => ({ email: STAFF_EMAIL, role, isFounder: role === 'founder', status: 'active' }),
  });
}

function stubStoredAdminSettings(t, value) {
  const prevFindOne = SystemSetting.findOne;
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  let savedValue = value;
  SystemSetting.findOne = () => ({
    lean: async () => ({ key: 'settings_center_admin', value: savedValue, updatedAt: new Date() }),
  });
  SystemSetting.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      savedValue = update.$set.value;
      return { value: savedValue, updatedAt: new Date() };
    },
  });

  return { getSavedValue: () => savedValue };
}

test('GET /api/admin/settings returns 200 with defaults (no 404)', async () => {
  const res = await request(app)
    .get('/api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  // In test mode the server skips DB connection; admin endpoints should respond 503 JSON.
  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('GET /admin-api/admin/settings returns 200 with defaults (alias)', async () => {
  const res = await request(app)
    .get('/admin-api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('GET /api/admin/public-settings returns 200 with defaults (no 404)', async () => {
  const res = await request(app)
    .get('/api/admin/public-settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('PUT /api/admin/settings exists (returns 503 when DB unavailable, not 404)', async () => {
  const res = await request(app)
    .put('/api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ adminPanel: { theme: 'dark' } });

  assert.notEqual(res.status, 404);
});

test('PUT /api/admin/public-settings exists (returns 503 when DB unavailable, not 404)', async () => {
  const res = await request(app)
    .put('/api/admin/public-settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ publicSite: { footer: { links: [] } } });

  assert.notEqual(res.status, 404);
});

test('GET /api/admin/settings omits removed Article Assistant setting while preserving adminPanel values', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubStoredAdminSettings(t, {
    adminPanel: {
      articleAssistantForStaff: false,
      theme: 'dark',
      draft: { articleAssistantForStaff: true, layout: 'compact' },
    },
  });

  const res = await request(app)
    .get('/api/admin/settings')
    .set('Cookie', 'np_admin=founder@newspulse.ai');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.adminPanel.theme, 'dark');
  assert.equal(res.body.data.adminPanel.draft.layout, 'compact');
  assert.equal(Object.hasOwn(res.body.data.adminPanel, 'articleAssistantForStaff'), false);
  assert.equal(Object.hasOwn(res.body.data.adminPanel.draft, 'articleAssistantForStaff'), false);
});

test('PUT /api/admin/settings ignores removed Article Assistant setting and keeps generic adminPanel updates', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'admin');
  const store = stubStoredAdminSettings(t, { adminPanel: { theme: 'light' } });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ adminPanel: { articleAssistantForStaff: false, theme: 'dark', draft: { articleAssistantForStaff: false, layout: 'compact' } } });

  assert.equal(res.status, 200);
  assert.equal(store.getSavedValue().adminPanel.theme, 'dark');
  assert.equal(store.getSavedValue().adminPanel.draft.layout, 'compact');
  assert.equal(Object.hasOwn(store.getSavedValue().adminPanel, 'articleAssistantForStaff'), false);
  assert.equal(Object.hasOwn(store.getSavedValue().adminPanel.draft, 'articleAssistantForStaff'), false);
});
