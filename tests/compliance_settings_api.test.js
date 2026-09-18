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

const CURRENT_SRB_REGISTRATION = Object.freeze({
  organization: 'Working Journalist Media Council (WJMC)',
  publisher: 'News Pulse (Digital)',
  status: 'Registered',
  registrationNumber: 'WJMC/7489/462-26',
  issueDate: '2026-09-14',
  validUntil: '2027-09-14',
});

function makeCompliancePayload(overrides = {}) {
  return {
    founderName: 'Kiran Parmar',
    founderDesignation: 'Founder, News Pulse',
    grievanceOfficerName: 'Asha Mehta',
    grievanceOfficerDesignation: 'Grievance Officer',
    grievanceEmail: 'legal@newspulse.co.in',
    grievanceOfficerLocation: 'India',
    publisherEntity: 'News Pulse Media',
    showPublisherEntity: true,
    showFounderPublisher: false,
    websiteUrl: 'https://www.newspulse.co.in',
    showChiefEditor: true,
    chiefEditorName: 'Ravi Shah',
    chiefEditorDesignation: 'Chief Editor',
    editorialEmail: 'editor@newspulse.co.in',
    ...overrides,
  };
}

function installComplianceStorageStubs(t, initialStored = {}) {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = ComplianceSettings.getOrCreate;
  const prevFindOneAndUpdate = ComplianceSettings.findOneAndUpdate;
  const prevPublicSiteGetOrCreate = PublicSiteSettings.getOrCreate;

  let stored = {
    scope: 'default',
    ...ComplianceSettings.getDefaultSettings(),
    ...initialStored,
  };

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    ComplianceSettings.getOrCreate = prevGetOrCreate;
    ComplianceSettings.findOneAndUpdate = prevFindOneAndUpdate;
    PublicSiteSettings.getOrCreate = prevPublicSiteGetOrCreate;
  });

  mongoose.connection.readyState = 1;

  ComplianceSettings.getOrCreate = async () => JSON.parse(JSON.stringify(stored));
  ComplianceSettings.findOneAndUpdate = async (_filter, update) => {
    stored = {
      ...stored,
      ...(update && update.$set ? update.$set : {}),
      updatedAt: '2026-09-18T01:00:00.000Z',
    };
    return JSON.parse(JSON.stringify(stored));
  };

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 9,
    published: PublicSiteSettings.getDefaultSettings(),
    publishedUpdatedAt: new Date('2026-09-18T01:00:00.000Z'),
    updatedAt: new Date('2026-09-18T01:00:00.000Z'),
  });

  return {
    getStored: () => JSON.parse(JSON.stringify(stored)),
  };
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
  assert.deepEqual(publicRes.body.item.srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.equal(Object.prototype.hasOwnProperty.call(publicRes.body.item, 'srbRegistrationHistory'), false);
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
  assert.deepEqual(adminGetRes.body.item.srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.deepEqual(adminGetRes.body.item.srbRegistrationHistory, []);

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
  assert.deepEqual(publicSettingsRes.body.published.srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.equal(Object.prototype.hasOwnProperty.call(publicSettingsRes.body.published, 'srbRegistrationHistory'), false);
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
  assert.deepEqual(res.body.published.srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.published, 'srbRegistrationHistory'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.published, 'grievanceOfficerLocation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.published, 'officerLocation'), false);
});

test('founder can renew SRB registration and public settings expose current only', async (t) => {
  installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const renewedRegistration = {
    ...CURRENT_SRB_REGISTRATION,
    registrationNumber: 'WJMC/7489/462-27',
    issueDate: '2027-09-15',
    validUntil: '2028-09-14',
  };

  const renewalRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send(makeCompliancePayload({
      srbRegistrationAction: 'renew',
      srbRegistration: renewedRegistration,
    }));

  assert.equal(renewalRes.status, 200);
  assert.deepEqual(renewalRes.body.item.srbRegistration, renewedRegistration);
  assert.equal(renewalRes.body.item.srbRegistrationHistory.length, 1);
  assert.equal(renewalRes.body.item.srbRegistrationHistory[0].registrationNumber, CURRENT_SRB_REGISTRATION.registrationNumber);
  assert.equal(renewalRes.body.item.srbRegistrationHistory[0].archivedAt.length > 0, true);

  const adminGetRes = await request(app)
    .get('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(adminGetRes.status, 200);
  assert.deepEqual(adminGetRes.body.item.srbRegistration, renewedRegistration);
  assert.equal(adminGetRes.body.item.srbRegistrationHistory.length, 1);

  const publicComplianceRes = await request(app).get('/api/public/compliance-settings');
  assert.equal(publicComplianceRes.status, 200);
  assert.deepEqual(publicComplianceRes.body.item.srbRegistration, renewedRegistration);
  assert.equal(Object.prototype.hasOwnProperty.call(publicComplianceRes.body.item, 'srbRegistrationHistory'), false);

  const publicSettingsRes = await request(app).get('/api/public/settings');
  assert.equal(publicSettingsRes.status, 200);
  assert.deepEqual(publicSettingsRes.body.published.srbRegistration, renewedRegistration);
  assert.equal(Object.prototype.hasOwnProperty.call(publicSettingsRes.body.published, 'srbRegistrationHistory'), false);
});

test('ordinary founder SRB update does not create duplicate history entry', async (t) => {
  const existingHistory = [{
    ...CURRENT_SRB_REGISTRATION,
    archivedAt: '2027-09-15T00:00:00.000Z',
  }];
  const currentRegistration = {
    ...CURRENT_SRB_REGISTRATION,
    registrationNumber: 'WJMC/7489/462-27',
    issueDate: '2027-09-15',
    validUntil: '2028-09-14',
  };
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: currentRegistration,
    srbRegistrationHistory: existingHistory,
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const res = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send(makeCompliancePayload({ srbRegistration: currentRegistration }));

  assert.equal(res.status, 200);
  assert.equal(res.body.item.srbRegistrationHistory.length, 1);
  assert.deepEqual(storage.getStored().srbRegistrationHistory, existingHistory);
});

test('founder SRB update accepts and preserves valid ISO date-only values', async (t) => {
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const updatedRegistration = {
    ...CURRENT_SRB_REGISTRATION,
    issueDate: '2026-10-01',
    validUntil: '2027-10-01',
  };

  const res = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send(makeCompliancePayload({ srbRegistration: updatedRegistration }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.item.srbRegistration, updatedRegistration);
  assert.deepEqual(storage.getStored().srbRegistration, updatedRegistration);
});

test('SRB registration rejects DD-MM-YYYY dates', async (t) => {
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const res = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send(makeCompliancePayload({
      srbRegistration: {
        ...CURRENT_SRB_REGISTRATION,
        issueDate: '14-09-2026',
        validUntil: '14-09-2027',
      },
    }));

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.errors.includes('srbRegistration.issueDate must be a valid YYYY-MM-DD date'), true);
  assert.equal(res.body.errors.includes('srbRegistration.validUntil must be a valid YYYY-MM-DD date'), true);
  assert.deepEqual(storage.getStored().srbRegistration, CURRENT_SRB_REGISTRATION);
});

test('SRB registration rejects malformed and impossible ISO date-only values', async (t) => {
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const invalidRegistrations = [
    { issueDate: '2026-9-14', validUntil: '2027-09-14' },
    { issueDate: '2026-02-31', validUntil: '2027-09-14' },
  ];

  for (const registrationDates of invalidRegistrations) {
    const res = await request(app)
      .put('/api/admin/compliance-settings')
      .set('Authorization', `Bearer ${founderToken}`)
      .send(makeCompliancePayload({
        srbRegistration: {
          ...CURRENT_SRB_REGISTRATION,
          ...registrationDates,
        },
      }));

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.errors.includes('srbRegistration.issueDate must be a valid YYYY-MM-DD date'), true);
  }
  assert.deepEqual(storage.getStored().srbRegistration, CURRENT_SRB_REGISTRATION);
});

test('SRB registration rejects invalid date ranges', async (t) => {
  installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const founderToken = makeOpaqueAdminToken('kiran@newspulse.co.in');
  const res = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${founderToken}`)
    .send(makeCompliancePayload({
      srbRegistration: {
        ...CURRENT_SRB_REGISTRATION,
        issueDate: '2027-09-14',
        validUntil: '2026-09-14',
      },
    }));

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.errors.includes('srbRegistration.validUntil must not be earlier than srbRegistration.issueDate'), true);
});

test('non-Founder can save other compliance fields with unchanged SRB registration included', async (t) => {
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const adminToken = makeOpaqueAdminToken('editor@newspulse.ai');
  const unchangedRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(makeCompliancePayload({
      grievanceEmail: 'compliance@newspulse.co.in',
      srbRegistration: CURRENT_SRB_REGISTRATION,
    }));

  assert.equal(unchangedRes.status, 200);
  assert.equal(unchangedRes.body.item.grievanceEmail, 'compliance@newspulse.co.in');
  assert.deepEqual(storage.getStored().srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.deepEqual(storage.getStored().srbRegistrationHistory, []);

  const changedRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(makeCompliancePayload({
      grievanceEmail: 'legal@newspulse.co.in',
      srbRegistration: {
        ...CURRENT_SRB_REGISTRATION,
        status: 'Renewed',
      },
    }));

  assert.equal(changedRes.status, 403);
  assert.deepEqual(storage.getStored().srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.deepEqual(storage.getStored().srbRegistrationHistory, []);
});

test('non-Founder cannot update or renew SRB registration', async (t) => {
  const storage = installComplianceStorageStubs(t, {
    srbRegistration: CURRENT_SRB_REGISTRATION,
    srbRegistrationHistory: [],
  });

  const adminToken = makeOpaqueAdminToken('editor@newspulse.ai');
  const updatedRegistration = {
    ...CURRENT_SRB_REGISTRATION,
    status: 'Renewed',
  };

  const updateRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(makeCompliancePayload({ srbRegistration: updatedRegistration }));

  assert.equal(updateRes.status, 403);

  const renewalRes = await request(app)
    .put('/api/admin/compliance-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(makeCompliancePayload({
      srbRegistrationAction: 'renew',
      srbRegistration: updatedRegistration,
    }));

  assert.equal(renewalRes.status, 403);
  assert.deepEqual(storage.getStored().srbRegistration, CURRENT_SRB_REGISTRATION);
  assert.deepEqual(storage.getStored().srbRegistrationHistory, []);
});

test('GET /api/admin/compliance-settings is protected', async () => {
  const res = await request(app).get('/api/admin/compliance-settings');
  assert.equal(res.status, 401);
});