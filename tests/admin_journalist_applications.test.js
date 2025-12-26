const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// Ensure server boot skips real Mongo connection
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

// Patch models used by the handler to avoid DB
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

// Minimal fake query builder for ReporterContact.find(...).sort().skip().limit().lean()
function makeFindResult(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return items; },
  };
}

// Provide deterministic data
const fakeContacts = [
  {
    _id: 'abc123',
    fullName: 'Jane Reporter',
    email: 'jane@example.com',
    phoneFull: '+911234567890',
    cityTownVillage: 'Mumbai',
    stateName: 'MH',
    country: 'India',
    reporterType: 'journalist',
    verificationLevel: 'pending',
    organisationName: 'News Co',
    organisationType: 'digital',
    positionTitle: 'Reporter',
    beatsProfessional: ['politics'],
    yearsExperience: 3,
    languages: ['en'],
    websiteOrPortfolio: null,
    socialLinks: {},
    verifiedBy: null,
    verifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

ReporterContact.find = () => makeFindResult(fakeContacts);
ReporterContact.countDocuments = async () => fakeContacts.length;
CommunitySubmission.countDocuments = async () => 0;

// 401 without auth
test('GET /admin/community/journalist-applications returns 401 when unauthenticated', async () => {
  const res = await request(app)
    .get('/admin/community/journalist-applications?status=pending')
    .send();
  assert.strictEqual(res.statusCode, 401);
});

// 200 with legacy admin cookie (middleware compatibility path)
test('GET /admin/community/journalist-applications returns 200 with admin cookie', async () => {
  const res = await request(app)
    .get('/admin/community/journalist-applications?status=pending')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.ok === true);
  assert.ok(Array.isArray(res.body.items));
});

test('POST verify sets verified + active', async () => {
  const contactStore = { ...fakeContacts[0] };
  ReporterContact.findById = async () => contactStore;
  const res = await request(app)
    .post('/admin/community/journalist-applications/abc123/verify')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.ok === true);
  assert.strictEqual(contactStore.verificationLevel, 'verified');
  assert.strictEqual(contactStore.status, 'active');
});

test('POST status can bump ethicsStrikes and change status', async () => {
  const mutable = { ...fakeContacts[0], ethicsStrikes: 0, status: 'active' };
  ReporterContact.findById = async () => mutable;
  const res = await request(app)
    .post('/admin/community/reporters/abc123/status')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ status: 'watchlist', addStrike: true, note: 'Test note' });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.ok === true);
  assert.strictEqual(mutable.status, 'watchlist');
  assert.strictEqual(mutable.ethicsStrikes, 1);
  assert.ok(Array.isArray(mutable.behaviourNotes));
});
