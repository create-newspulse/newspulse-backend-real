const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const ComplianceSettings = require('../models/ComplianceSettings');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('compliance settings admin and public contract', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = ComplianceSettings.getOrCreate;
  const prevFindOneAndUpdate = ComplianceSettings.findOneAndUpdate;

  let stored = null;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    ComplianceSettings.getOrCreate = prevGetOrCreate;
    ComplianceSettings.findOneAndUpdate = prevFindOneAndUpdate;
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
});

test('GET /api/admin/compliance-settings is protected', async () => {
  const res = await request(app).get('/api/admin/compliance-settings');
  assert.equal(res.status, 401);
});