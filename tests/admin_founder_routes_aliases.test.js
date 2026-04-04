const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ENABLE_TOGGLE_QUERY_IN_TESTS = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
require('dotenv').config();

const FounderFeatureToggles = require('../models/FounderFeatureToggles');
const FeatureToggles = require('../models/FeatureToggles');
const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');
const CommunitySettings = require('../models/CommunitySettings');
const SystemSettings = require('../models/SystemSettings');

let founderDoc;
let legacyFeatureDoc;
let communityFeatureDoc;
let communitySettingsDoc;
let systemSettingsDoc;

function makeLeanResult(value) {
  return {
    lean: async () => value,
  };
}

FounderFeatureToggles.findOne = () => makeLeanResult(founderDoc);
FounderFeatureToggles.findOneAndUpdate = async (_filter, update) => {
  const patch = {
    ...(update && update.$setOnInsert ? update.$setOnInsert : {}),
    ...(update && update.$set ? update.$set : {}),
  };
  founderDoc = {
    key: 'community_feature_toggles',
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-05T10:00:00.000Z'),
    ...founderDoc,
    ...patch,
  };
  return founderDoc;
};
FeatureToggles.findOne = () => makeLeanResult(legacyFeatureDoc);
CommunityFeatureSettings.findOne = () => makeLeanResult(communityFeatureDoc);
CommunitySettings.findOne = () => makeLeanResult(communitySettingsDoc);
SystemSettings.findOne = () => makeLeanResult(systemSettingsDoc);

const app = require('../server');

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
    { expiresIn: '2h' }
  );
}

test.beforeEach(() => {
  founderDoc = {
    key: 'community_feature_toggles',
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-05T10:00:00.000Z'),
  };
  legacyFeatureDoc = {
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-04T10:00:00.000Z'),
  };
  communityFeatureDoc = {
    key: 'community',
    communityReporterEnabled: true,
    reporterPortalEnabled: true,
    allowNewSubmissions: true,
    allowMyStoriesPortal: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
  communitySettingsDoc = {
    communityReporterEnabled: true,
    allowNewSubmissions: true,
    allowMyStoriesPortal: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
  systemSettingsDoc = {
    communityMyStoriesEnabled: true,
    communityReporterEnabled: true,
    reporterPortalEnabled: true,
    allowNewSubmissions: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
});

test('GET /admin-api/admin/community/contributors resolves to the contributor directory handler', async () => {
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .get('/admin-api/admin/community/contributors')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.notStrictEqual(res.statusCode, 404);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.message, 'Database not connected');
});

test('founder feature toggle aliases accept valid founder auth and reject non-founder auth', async () => {
  const founderToken = signToken('founder', 'founder@example.com');
  const adminToken = signToken('admin', 'admin@example.com');

  const getRes = await request(app)
    .get('/admin-api/admin/founder/feature-toggles')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.strictEqual(getRes.statusCode, 200);
  assert.strictEqual(getRes.body.ok, true);
  assert.strictEqual(getRes.body.communityReporterClosed, false);
  assert.strictEqual(getRes.body.reporterPortalClosed, false);
  assert.ok(getRes.body.data);

  const patchRes = await request(app)
    .patch('/admin-api/admin/founder/feature-toggles')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ communityReporterClosed: true, reporterPortalClosed: true });

  assert.strictEqual(patchRes.statusCode, 200);
  assert.strictEqual(patchRes.body.ok, true);
  assert.strictEqual(patchRes.body.communityReporterClosed, true);
  assert.strictEqual(patchRes.body.reporterPortalClosed, true);

  const nonFounderRes = await request(app)
    .get('/admin-api/admin/founder/feature-toggles')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.strictEqual(nonFounderRes.statusCode, 403);
});

test('founder settings save route safely accepts nested featureToggles payloads', async () => {
  const founderToken = signToken('founder', 'founder@example.com');

  const res = await request(app)
    .patch('/admin-api/admin/founder/settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({
      adminPanel: { founderCommand: { tab: 'feature-toggles' } },
      featureToggles: {
        communityReporterClosed: true,
        reporterPortalClosed: false,
      },
      aiTrainingInfo: {
        notes: 'Founder notes',
      },
    });

  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.message, 'DB unavailable');
});

test('founder settings and ai-training-info aliases return valid JSON instead of falling through', async () => {
  const founderToken = signToken('founder', 'founder@example.com');

  const settingsRes = await request(app)
    .get('/admin-api/admin/founder/settings')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.strictEqual(settingsRes.statusCode, 200);
  assert.strictEqual(settingsRes.body.ok, true);
  assert.strictEqual(settingsRes.body.success, true);
  assert.ok(settingsRes.body.data);
  assert.ok(Object.prototype.hasOwnProperty.call(settingsRes.body.data, 'sections'));
  assert.ok(Object.prototype.hasOwnProperty.call(settingsRes.body.data, 'adminPanel'));
  assert.ok(Object.prototype.hasOwnProperty.call(settingsRes.body.data, 'featureToggles'));
  assert.ok(Object.prototype.hasOwnProperty.call(settingsRes.body.data, 'aiTrainingInfo'));
  assert.ok(String(settingsRes.headers['content-type'] || '').includes('application/json'));

  const aiRes = await request(app)
    .get('/admin-api/admin/founder/ai-training-info')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.strictEqual(aiRes.statusCode, 200);
  assert.strictEqual(aiRes.body.ok, true);
  assert.strictEqual(aiRes.body.success, true);
  assert.ok(aiRes.body.data);
  assert.ok(Array.isArray(aiRes.body.data.sources));
  assert.ok(String(aiRes.headers['content-type'] || '').includes('application/json'));
});