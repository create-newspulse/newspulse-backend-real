const test = require('node:test');
const assert = require('node:assert');

const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const reporterContactService = require('../services/reporterContactService');

let originalFindOneAndUpdate;
let originalCountDocuments;
let originalFindOne;
let originalReporterContactFindOne;

function makeFindOneResult(value) {
  return {
    sort() {
      return this;
    },
    lean: async () => value,
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

test.before(() => {
  originalFindOneAndUpdate = ReporterContact.findOneAndUpdate;
  originalCountDocuments = CommunitySubmission.countDocuments;
  originalFindOne = CommunitySubmission.findOne;
  originalReporterContactFindOne = ReporterContact.findOne;
});

test.after(() => {
  ReporterContact.findOneAndUpdate = originalFindOneAndUpdate;
  CommunitySubmission.countDocuments = originalCountDocuments;
  CommunitySubmission.findOne = originalFindOne;
  ReporterContact.findOne = originalReporterContactFindOne;
});

test('upsertReporterContact sets reporterKey from normalized email', async () => {
  let capturedFilter = null;
  let capturedUpdate = null;

  ReporterContact.findOneAndUpdate = async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return {
      _id: '507f191e810c19729de860aa',
      email: 'newspulse.team@gmail.com',
      emailLower: 'newspulse.team@gmail.com',
      reporterKey: 'newspulse.team@gmail.com',
      save: async function save() {
        return this;
      },
    };
  };

  await reporterContactService.upsertReporterContact({
    name: 'Kiran Parmar',
    email: 'NewsPulse.Team@gmail.com',
    reporterType: 'community',
  });

  assert.deepStrictEqual(capturedFilter, {
    email: 'newspulse.team@gmail.com',
    $or: [{ emailLower: 'newspulse.team@gmail.com' }, { email: 'newspulse.team@gmail.com' }],
  });
  assert.strictEqual(capturedUpdate.$set.emailLower, 'newspulse.team@gmail.com');
  assert.strictEqual(capturedUpdate.$set.reporterKey, 'newspulse.team@gmail.com');
  assert.strictEqual(capturedUpdate.$setOnInsert.email, 'newspulse.team@gmail.com');
  assert.strictEqual(capturedUpdate.$setOnInsert.directoryStatus, 'active');
});

test('upsertReporterContactFromSubmission uses normalized submission email for reporterKey-safe upsert', async () => {
  ReporterContact.findOneAndUpdate = async (_filter, _update) => ({
    _id: '507f191e810c19729de860ab',
    email: 'newspulse.team@gmail.com',
    emailLower: 'newspulse.team@gmail.com',
    reporterKey: 'newspulse.team@gmail.com',
    save: async function save() {
      return this;
    },
  });
  CommunitySubmission.countDocuments = async () => 3;
  CommunitySubmission.findOne = () => makeFindOneResult({
    headline: 'Latest story',
    createdAt: new Date('2026-04-05T12:00:00.000Z'),
  });

  const result = await reporterContactService.upsertReporterContactFromSubmission({
    reporterEmail: 'NewsPulse.Team@gmail.com',
    reporterName: 'Kiran Parmar',
    sourceType: 'community',
  });

  assert.ok(result);
  assert.strictEqual(String(result.contactId), '507f191e810c19729de860ab');
});

test('upsertReporterContact maps richer community reporter fields without blank overwrites', async () => {
  let capturedUpdate = null;

  ReporterContact.db = { readyState: 1 };
  ReporterContact.findOne = async () => ({
    _id: '507f191e810c19729de860ac',
    email: 'reporter@example.com',
    phoneFull: '+919999000000',
    whatsappNumber: '+919999000001',
    cityTownVillage: 'Ahmedabad',
    districtName: 'Ahmedabad',
    stateName: 'Gujarat',
    country: 'India',
    save: async function save() {
      return this;
    },
  });
  ReporterContact.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    return {
      _id: '507f191e810c19729de860ac',
      email: 'reporter@example.com',
      emailLower: 'reporter@example.com',
      reporterKey: 'reporter@example.com',
      save: async function save() {
        return this;
      },
    };
  };

  await reporterContactService.upsertReporterContact({
    name: 'Portal Reporter',
    email: 'reporter@example.com',
    phone: '',
    whatsapp: '',
    district: 'Surat',
    area: 'Adajan',
    areaType: 'town',
    coverageScope: 'regional',
    beat: 'civic',
    organisationName: 'News Guild',
    portalAccessEnabled: true,
    portalAuthVersion: 4,
  });

  assert.ok(capturedUpdate);
  assert.strictEqual(capturedUpdate.$set.phoneFull, undefined);
  assert.strictEqual(capturedUpdate.$set.whatsappNumber, undefined);
  assert.strictEqual(capturedUpdate.$set.districtName, 'Surat');
  assert.strictEqual(capturedUpdate.$set.areaName, 'Adajan');
  assert.strictEqual(capturedUpdate.$set.areaType, 'TOWN');
  assert.strictEqual(capturedUpdate.$set.coverageScope, 'regional');
  assert.strictEqual(capturedUpdate.$set.primaryBeat, 'civic');
  assert.strictEqual(capturedUpdate.$set.organisationName, 'News Guild');
  assert.strictEqual(capturedUpdate.$set.portalAccessEnabled, true);
  assert.strictEqual(capturedUpdate.$set.portalAuthVersion, 4);
});

test('upsertReporterContact preserves existing removed directory state during rebuild-style updates', async () => {
  let capturedUpdate = null;

  ReporterContact.db = { readyState: 1 };
  ReporterContact.findOne = async () => ({
    _id: '507f191e810c19729de860ad',
    email: 'removed@example.com',
    emailLower: 'removed@example.com',
    reporterKey: 'removed@example.com',
    directoryStatus: 'removed',
    status: 'suspended',
  });
  ReporterContact.findOneAndUpdate = async (_filter, update) => {
    capturedUpdate = update;
    return {
      _id: '507f191e810c19729de860ad',
      email: 'removed@example.com',
      emailLower: 'removed@example.com',
      reporterKey: 'removed@example.com',
      directoryStatus: 'removed',
      status: 'suspended',
      save: async function save() {
        return this;
      },
    };
  };

  await reporterContactService.upsertReporterContact({
    name: 'Removed Reporter',
    email: 'removed@example.com',
    phone: '+919876543210',
    district: 'Surat',
    reporterType: 'community',
  });

  assert.ok(capturedUpdate);
  assert.strictEqual(capturedUpdate.$set.directoryStatus, undefined);
  assert.strictEqual(capturedUpdate.$set.status, undefined);
  assert.strictEqual(capturedUpdate.$set.phoneFull, '+919876543210');
  assert.strictEqual(capturedUpdate.$set.districtName, 'Surat');
  assert.strictEqual(capturedUpdate.$setOnInsert.directoryStatus, 'active');
});
