const test = require('node:test');
const assert = require('node:assert');

const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const reporterContactService = require('../services/reporterContactService');

let originalFindOneAndUpdate;
let originalCountDocuments;
let originalFindOne;

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
});

test.after(() => {
  ReporterContact.findOneAndUpdate = originalFindOneAndUpdate;
  CommunitySubmission.countDocuments = originalCountDocuments;
  CommunitySubmission.findOne = originalFindOne;
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
