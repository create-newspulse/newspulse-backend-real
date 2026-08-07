const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const SiteSettings = require('../models/SiteSettings');

let siteSettingsDoc;

SiteSettings.findOne = async () => siteSettingsDoc;
SiteSettings.create = async (payload) => {
  siteSettingsDoc = {
    ...payload,
    async save() {
      return this;
    },
  };
  return siteSettingsDoc;
};

const router = require('../routes/adminSafeOwnerZoneFeatureVisibility.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return app;
}

function signToken(role, email) {
  return jwt.sign(
    {
      sub: `${role}-id`,
      email,
      name: role,
      role,
      tokenVersion: 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '2h' },
  );
}

test.beforeEach(() => {
  siteSettingsDoc = {
    brandName: 'News Pulse',
    adminFeatureVisibility: {
      addNews: false,
      liveTv: false,
      unsupportedKey: false,
    },
    async save() {
      return this;
    },
  };
});

test('GET /api/admin/safe-owner-zone/feature-visibility returns normalized defaults for founder', async () => {
  const app = buildApp();
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .get('/api/admin/safe-owner-zone/feature-visibility')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.visibility.addNews, false);
  assert.strictEqual(res.body.visibility.liveTv, false);
  assert.strictEqual(res.body.visibility.manageNews, false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.visibility, 'unsupportedKey'), false);
});

test('PUT /api/admin/safe-owner-zone/feature-visibility updates only known boolean keys', async () => {
  const app = buildApp();
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .put('/api/admin/safe-owner-zone/feature-visibility')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      visibility: {
        manageNews: false,
        analytics: false,
      },
    });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.visibility.manageNews, false);
  assert.strictEqual(res.body.visibility.analytics, false);
  assert.strictEqual(res.body.visibility.addNews, false);
  assert.strictEqual(siteSettingsDoc.adminFeatureVisibility.manageNews, false);
  assert.strictEqual(siteSettingsDoc.adminFeatureVisibility.analytics, false);
});

test('PUT /api/admin/safe-owner-zone/feature-visibility rejects unknown keys and non-boolean values', async () => {
  const app = buildApp();
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .put('/api/admin/safe-owner-zone/feature-visibility')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      visibility: {
        dashboard: false,
        addNews: 'no',
      },
    });

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.deepStrictEqual(res.body.invalidKeys, ['dashboard']);
  assert.deepStrictEqual(res.body.invalidValueKeys, ['addNews']);
});

test('safe owner zone feature visibility remains founder-only', async () => {
  const app = buildApp();
  const adminToken = signToken('admin', 'admin@example.com');

  const res = await request(app)
    .get('/api/admin/safe-owner-zone/feature-visibility')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, 'FOUNDER_REQUIRED');
});

test('server mounts safe owner zone feature visibility on admin-api alias', async () => {
  const app = require('../server');
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .get('/admin-api/admin/safe-owner-zone/feature-visibility')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.visibility.addNews, false);
  assert.strictEqual(res.body.visibility.manageNews, false);
});