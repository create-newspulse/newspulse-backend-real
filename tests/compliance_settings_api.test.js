const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const ComplianceSettings = require('../models/ComplianceSettings');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('compliance settings admin and public contract', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = ComplianceSettings.getOrCreate;
  const prevFindOneAndUpdate = ComplianceSettings.findOneAndUpdate;
  const prevPublicSiteGetOrCreate = PublicSiteSettings.getOrCreate;

  let stored = null;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    ComplianceSettings.getOrCreate = prevGetOrCreate;
    ComplianceSettings.findOneAndUpdate = prevFindOneAndUpdate;
    PublicSiteSettings.getOrCreate = prevPublicSiteGetOrCreate;
  });

  mongoose.connection.readyState = 1;

  ComplianceSettings.getOrCreate = async () => {
    if (!stored) {
      stored = {
        scope: 'default',
        founderName: 'Kiran Parmar',
        founderDesignation: 'Founder, News Pulse',
        publisherEntity: 'News Pulse Media',
        showPublisherEntity: true,
        showFounderPublisher: false,
        websiteUrl: 'https://www.newspulse.co.in',
        officerName: 'Legacy Grievance Officer',
        officerDesignation: 'Legacy Officer',
        showChiefEditor: true,
        updatedAt: '2026-05-13T00:00:00.000Z',
      };
    }
    return { ...stored };
  };

  ComplianceSettings.findOneAndUpdate = async (_filter, update) => {
    stored = {
      scope: 'default',
      ...(stored || ComplianceSettings.getDefaultSettings()),
      ...update.$set,
      updatedAt: '2026-05-13T01:00:00.000Z',
    };
    return { ...stored };
  };

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 7,
    published: PublicSiteSettings.getDefaultSettings(),
    publishedUpdatedAt: new Date('2026-05-13T01:00:00.000Z'),
    updatedAt: new Date('2026-05-13T01:00:00.000Z'),
  });

  const publicRes = await request(app).get('/api/public/compliance-settings');
  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.body.ok, true);
  assert.equal(publicRes.body.item.founderName, 'Kiran Parmar');
  assert.equal(publicRes.body.item.founderDesignation, 'Founder, News Pulse');
  assert.equal(publicRes.body.item.showPublisherEntity, true);
  assert.equal(publicRes.body.item.showFounderPublisher, false);
  assert.equal(publicRes.body.item.grievanceOfficerName, 'Legacy Grievance Officer');
  assert.equal(publicRes.body.item.officerName, 'Legacy Grievance Officer');
  assert.equal(publicRes.body.item.grievanceOfficerDesignation, 'Legacy Officer');
  assert.equal(publicRes.body.item.grievanceEmail, 'grievance@newspulse.co.in');
  assert.equal(publicRes.body.item.websiteUrl, 'https://www.newspulse.co.in');
  assert.equal(publicRes.body.item.showChiefEditor, true);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRes.body.item, 'mobileNumber'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRes.body.item, 'grievanceOfficerLocation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRes.body.item, 'officerLocation'), false);

  const token = makeOpaqueAdminToken();
  const adminGetRes = await request(app)
    .get('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(adminGetRes.status, 200);
  assert.equal(adminGetRes.body.ok, true);
  assert.equal(adminGetRes.body.item.publisherEntity, 'News Pulse Media');
  assert.equal(adminGetRes.body.item.showPublisherEntity, true);
  assert.equal(adminGetRes.body.item.showFounderPublisher, false);
  assert.equal(adminGetRes.body.item.chiefEditorDesignation, 'Chief Editor');
  assert.equal(adminGetRes.body.item.showChiefEditor, true);

  const adminUpdateRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      founderName: 'Kiran Parmar',
      founderDesignation: 'Founder, News Pulse',
      grievanceOfficerName: 'Asha Mehta',
      grievanceOfficerDesignation: 'Grievance Officer',
      grievanceEmail: 'legal@newspulse.co.in',
      grievanceOfficerLocation: 'India',
      publisherEntity: 'News Pulse Media',
      showPublisherEntity: false,
      showFounderPublisher: true,
      websiteUrl: 'https://www.newspulse.co.in',
      showChiefEditor: false,
      chiefEditorName: 'Ravi Shah',
      chiefEditorDesignation: 'Chief Editor',
      editorialEmail: 'editor@newspulse.co.in',
    });

  assert.equal(adminUpdateRes.status, 200);
  assert.equal(adminUpdateRes.body.ok, true);
  assert.equal(adminUpdateRes.body.item.grievanceEmail, 'legal@newspulse.co.in');
  assert.equal(adminUpdateRes.body.item.grievanceOfficerName, 'Asha Mehta');
  assert.equal(adminUpdateRes.body.item.officerName, 'Asha Mehta');
  assert.equal(adminUpdateRes.body.item.showPublisherEntity, false);
  assert.equal(adminUpdateRes.body.item.showFounderPublisher, true);
  assert.equal(adminUpdateRes.body.item.showChiefEditor, false);
  assert.equal(adminUpdateRes.body.item.chiefEditorName, 'Ravi Shah');

  const publicAfterUpdateRes = await request(app).get('/api/public/compliance-settings');
  assert.equal(publicAfterUpdateRes.status, 200);
  assert.equal(publicAfterUpdateRes.body.item.grievanceEmail, 'legal@newspulse.co.in');
  assert.equal(publicAfterUpdateRes.body.item.grievanceOfficerName, 'Asha Mehta');
  assert.equal(publicAfterUpdateRes.body.item.showPublisherEntity, false);
  assert.equal(publicAfterUpdateRes.body.item.showFounderPublisher, true);
  assert.equal(publicAfterUpdateRes.body.item.showChiefEditor, false);
  assert.equal(publicAfterUpdateRes.body.item.chiefEditorName, 'Ravi Shah');

  const publicSettingsRes = await request(app).get('/api/public/settings');
  assert.equal(publicSettingsRes.status, 200);
  assert.equal(publicSettingsRes.body.ok, true);
  assert.equal(publicSettingsRes.body.published.showPublisherEntity, false);
  assert.equal(publicSettingsRes.body.published.showFounderPublisher, true);
  assert.equal(publicSettingsRes.body.published.showChiefEditor, false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicSettingsRes.body.published, 'grievanceOfficerLocation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicSettingsRes.body.published, 'officerLocation'), false);

  const secondAdminUpdateRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      founderName: 'Kiran Parmar',
      founderDesignation: 'Founder, News Pulse',
      grievanceOfficerName: 'Asha Mehta',
      grievanceOfficerDesignation: 'Grievance Officer',
      grievanceEmail: 'legal@newspulse.co.in',
      grievanceOfficerLocation: '',
      publisherEntity: 'News Pulse Media',
      showPublisherEntity: true,
      showFounderPublisher: false,
      websiteUrl: 'https://www.newspulse.co.in',
      showChiefEditor: true,
      chiefEditorName: 'Ravi Shah',
      chiefEditorDesignation: 'Chief Editor',
      editorialEmail: 'editor@newspulse.co.in',
    });

  assert.equal(secondAdminUpdateRes.status, 200);
  assert.equal(secondAdminUpdateRes.body.item.showPublisherEntity, true);
  assert.equal(secondAdminUpdateRes.body.item.showFounderPublisher, false);
  assert.equal(secondAdminUpdateRes.body.item.showChiefEditor, true);

  const publicSettingsAfterSecondUpdateRes = await request(app).get('/api/public/settings');
  assert.equal(publicSettingsAfterSecondUpdateRes.status, 200);
  assert.equal(publicSettingsAfterSecondUpdateRes.body.published.showPublisherEntity, true);
  assert.equal(publicSettingsAfterSecondUpdateRes.body.published.showFounderPublisher, false);
  assert.equal(publicSettingsAfterSecondUpdateRes.body.published.showChiefEditor, true);
});

test('GET /api/public/settings uses existing compliance defaults for older settings records', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevComplianceGetOrCreate = ComplianceSettings.getOrCreate;
  const prevPublicSiteGetOrCreate = PublicSiteSettings.getOrCreate;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    ComplianceSettings.getOrCreate = prevComplianceGetOrCreate;
    PublicSiteSettings.getOrCreate = prevPublicSiteGetOrCreate;
  });

  mongoose.connection.readyState = 1;

  ComplianceSettings.getOrCreate = async () => ({
    scope: 'default',
    founderName: 'Kiran Parmar',
    founderDesignation: 'Founder, News Pulse',
    publisherEntity: 'News Pulse Media',
    websiteUrl: 'https://www.newspulse.co.in',
    updatedAt: '2026-05-13T00:00:00.000Z',
  });

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 8,
    published: PublicSiteSettings.getDefaultSettings(),
    publishedUpdatedAt: new Date('2026-05-13T02:00:00.000Z'),
    updatedAt: new Date('2026-05-13T02:00:00.000Z'),
  });

  const res = await request(app).get('/api/public/settings');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.published.showPublisherEntity, true);
  assert.equal(res.body.published.showFounderPublisher, false);
  assert.equal(res.body.published.showChiefEditor, true);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.published, 'grievanceOfficerLocation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.published, 'officerLocation'), false);
});

test('GET /api/admin/compliance-settings is protected', async () => {
  const res = await request(app).get('/api/admin/compliance-settings');
  assert.equal(res.status, 401);
});