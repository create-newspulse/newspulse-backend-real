const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ENABLE_TOGGLE_QUERY_IN_TESTS = '1';
require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

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
    updatedAt: new Date('2026-04-04T10:00:00.000Z'),
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

test.beforeEach(() => {
  founderDoc = {
    key: 'community_feature_toggles',
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-04T10:00:00.000Z'),
  };
  legacyFeatureDoc = {
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-03T10:00:00.000Z'),
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

test('public feature endpoints expose founder closed state as effective truth', async () => {
  founderDoc.communityReporterClosed = true;
  founderDoc.reporterPortalClosed = true;
  communityFeatureDoc.communityReporterEnabled = true;
  communityFeatureDoc.reporterPortalEnabled = true;
  communitySettingsDoc.allowNewSubmissions = true;
  communitySettingsDoc.allowMyStoriesPortal = true;
  systemSettingsDoc.communityMyStoriesEnabled = true;

  const [featureRes, settingsRes, configRes] = await Promise.all([
    request(app).get('/api/public/feature-toggles'),
    request(app).get('/api/public/community/settings'),
    request(app).get('/api/community-reporter/config'),
  ]);

  assert.strictEqual(featureRes.statusCode, 200);
  assert.strictEqual(featureRes.body.settings.communityReporterClosed, true);
  assert.strictEqual(featureRes.body.settings.reporterPortalClosed, true);
  assert.strictEqual(featureRes.body.settings.communityReporterEnabled, false);
  assert.strictEqual(featureRes.body.settings.reporterPortalEnabled, false);

  assert.strictEqual(settingsRes.statusCode, 200);
  assert.strictEqual(settingsRes.body.settings.communityReporterEnabled, false);
  assert.strictEqual(settingsRes.body.settings.allowNewSubmissions, false);
  assert.strictEqual(settingsRes.body.settings.reporterPortalEnabled, false);
  assert.strictEqual(settingsRes.body.settings.allowMyStoriesPortal, false);
  assert.strictEqual(settingsRes.body.featureToggles.communityReporterClosed, true);
  assert.strictEqual(settingsRes.body.featureToggles.reporterPortalClosed, true);

  assert.strictEqual(configRes.statusCode, 200);
  assert.strictEqual(configRes.body.communityMyStoriesEnabled, false);
  assert.strictEqual(configRes.body.reporterPortalClosed, true);
});

test('community reporter and reporter portal public routes are blocked when founder toggles close them', async () => {
  founderDoc.communityReporterClosed = true;

  const submissionRes = await request(app)
    .post('/api/community-reporter/submissions')
    .send({
      name: 'Citizen Reporter',
      email: 'citizen@example.com',
      location: 'Ahmedabad',
      category: 'local',
      headline: 'Test Headline',
      story: 'Test story body content',
    });

  assert.strictEqual(submissionRes.statusCode, 503);
  assert.strictEqual(submissionRes.body.code, 'COMMUNITY_REPORTER_CLOSED');

  founderDoc.communityReporterClosed = false;
  founderDoc.reporterPortalClosed = true;

  const myStoriesRes = await request(app)
    .get('/api/community-reporter/my-stories')
    .query({ email: 'citizen@example.com' });

  assert.strictEqual(myStoriesRes.statusCode, 503);
  assert.strictEqual(myStoriesRes.body.code, 'REPORTER_PORTAL_CLOSED');
});