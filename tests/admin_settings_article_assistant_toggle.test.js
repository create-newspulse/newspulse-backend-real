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
    { sub: 'admin-id', email: STAFF_EMAIL, role: 'admin', ...overrides },
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

function stubStoredAdminSettings(t, adminPanelValue) {
  const prevFindOne = SystemSetting.findOne;
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  let savedValue = adminPanelValue === undefined ? null : { adminPanel: adminPanelValue };

  SystemSetting.findOne = (filter) => ({
    lean: async () => {
      if (filter && filter.key !== ADMIN_SETTINGS_KEY) return null;
      return savedValue ? { key: ADMIN_SETTINGS_KEY, value: savedValue, updatedAt: new Date() } : null;
    },
  });

  SystemSetting.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      savedValue = update.$set.value;
      return { value: savedValue, updatedAt: new Date() };
    },
  });

  return {
    getSavedValue: () => savedValue,
  };
}

test('GET /api/admin/settings: missing articleAssistantForStaff defaults to true', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubStoredAdminSettings(t, { theme: 'dark' });

  const res = await request(app)
    .get('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.adminPanel.articleAssistantForStaff, true);
  assert.equal(res.body.data.adminPanel.theme, 'dark');
});

test('GET /api/admin/settings: existing stored true returns true', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubStoredAdminSettings(t, { articleAssistantForStaff: true });

  const res = await request(app)
    .get('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.adminPanel.articleAssistantForStaff, true);
});

test('GET /api/admin/settings: existing stored false returns false', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  stubStoredAdminSettings(t, { articleAssistantForStaff: false });

  const res = await request(app)
    .get('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.adminPanel.articleAssistantForStaff, false);
});

test('PUT /api/admin/settings: Founder can set true -> false', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  const store = stubStoredAdminSettings(t, { articleAssistantForStaff: true });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ adminPanel: { articleAssistantForStaff: false } });

  assert.equal(res.status, 200);
  assert.equal(store.getSavedValue().adminPanel.articleAssistantForStaff, false);
});

test('PUT /api/admin/settings: Founder can set false -> true', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  const store = stubStoredAdminSettings(t, { articleAssistantForStaff: false });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ adminPanel: { articleAssistantForStaff: true } });

  assert.equal(res.status, 200);
  assert.equal(store.getSavedValue().adminPanel.articleAssistantForStaff, true);
});

test('PUT /api/admin/settings: Admin cannot modify articleAssistantForStaff (403)', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'admin');
  stubStoredAdminSettings(t, { articleAssistantForStaff: true });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'admin' })}`)
    .send({ adminPanel: { articleAssistantForStaff: false } });

  assert.equal(res.status, 403);
});

test('PUT /api/admin/settings: Manager cannot modify articleAssistantForStaff (403)', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'manager');
  stubStoredAdminSettings(t, { articleAssistantForStaff: true });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'manager' })}`)
    .send({ adminPanel: { articleAssistantForStaff: false } });

  assert.equal(res.status, 403);
});

test('PUT /api/admin/settings: Editor/staff cannot modify articleAssistantForStaff (403)', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'editor');
  stubStoredAdminSettings(t, { articleAssistantForStaff: true });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'editor' })}`)
    .send({ adminPanel: { articleAssistantForStaff: false } });

  assert.equal(res.status, 403);
});

test('PUT /api/admin/settings: non-Founder request including this field is rejected even with other valid settings', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'admin');
  const store = stubStoredAdminSettings(t, { articleAssistantForStaff: true, theme: 'light' });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'admin' })}`)
    .send({ adminPanel: { theme: 'dark', articleAssistantForStaff: false } });

  assert.equal(res.status, 403);
  // Nothing should have been persisted.
  assert.equal(store.getSavedValue().adminPanel.theme, 'light');
  assert.equal(store.getSavedValue().adminPanel.articleAssistantForStaff, true);
});

test('PUT /api/admin/settings: other admin settings behavior unaffected for non-Founder', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'admin');
  const store = stubStoredAdminSettings(t, { articleAssistantForStaff: true, theme: 'light' });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'admin' })}`)
    .send({ adminPanel: { theme: 'dark' } });

  assert.equal(res.status, 200);
  assert.equal(store.getSavedValue().adminPanel.theme, 'dark');
  // Untouched protected field is preserved by the safe merge.
  assert.equal(store.getSavedValue().adminPanel.articleAssistantForStaff, true);
});

test('PUT /api/admin/settings: nested adminPanel settings are merged safely and not erased', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  const store = stubStoredAdminSettings(t, {
    articleAssistantForStaff: true,
    theme: 'light',
    founderCommand: { tab: 'feature-toggles' },
  });

  const res = await request(app)
    .put('/api/admin/settings')
    .set('Authorization', `Bearer ${signAdminToken({ role: 'founder' })}`)
    .send({ adminPanel: { theme: 'dark' } });

  assert.equal(res.status, 200);
  const saved = store.getSavedValue().adminPanel;
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.articleAssistantForStaff, true);
  assert.deepEqual(saved.founderCommand, { tab: 'feature-toggles' });
});
