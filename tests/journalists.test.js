const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
require('dotenv').config();

// Minimal env required for admin auth middleware (uses JWT_SECRET)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const app = require('../server');

// Monkey-patch ReporterContact & CommunitySubmission DB methods to avoid real Mongo requirement in NODE_ENV=test.
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

let storedContacts = new Map(); // key: email -> contact object
let submissions = []; // store submission docs

// Patch findOne / findOneAndUpdate / findById / save behavior
ReporterContact.findOne = async (q) => {
  const email = q.email;
  return storedContacts.get(email) || null;
};
ReporterContact.findOneAndUpdate = async (q, update, opts) => {
  const email = q.email;
  let doc = storedContacts.get(email);
  if (!doc) {
    doc = { _id: { toString: () => 'contact-id-1' }, fullName: update.$set?.fullName || 'Unknown', email, reporterType: 'community', verificationLevel: 'unverified' };
  }
  Object.assign(doc, update.$set || {});
  storedContacts.set(email, doc);
  return doc;
};
ReporterContact.findById = async (id) => {
  for (const c of storedContacts.values()) {
    if (c._id.toString() === id) return c;
  }
  return null;
};
ReporterContact.prototype.save = async function() {
  storedContacts.set(this.email, this);
  return this;
};
// Monkey patch create via new ReporterContact().save already handled.

CommunitySubmission.create = async (payload) => {
  const doc = { ...payload, _id: { toString: () => 'submission-id-1' }, createdAt: new Date(), reporterId: payload.reporterId };
  submissions.push(doc);
  return doc;
};
CommunitySubmission.countDocuments = async (q) => {
  if (q && q.reporterId) {
    return submissions.filter(s => String(s.reporterId) === String(q.reporterId)).length;
  }
  return submissions.length;
};
CommunitySubmission.updateMany = async (_q, _u) => ({ acknowledged: true });

test('Journalist apply endpoint sets pending status', async () => {
  const res = await request(app)
    .post('/api/journalists/apply')
    .send({
      name: 'Test Journalist',
      email: 'journalist@example.com',
      phone: '1234567890',
      city: 'Mumbai',
      state: 'MH',
      country: 'India',
      organisationName: 'Example Media',
      organisationType: 'digital',
      positionTitle: 'Reporter',
      beats: ['politics'],
      yearsExperience: 3,
      languages: ['en'],
      websiteOrPortfolio: 'https://example.com',
      socialLinks: { twitter: 'https://twitter.com/example' },
    })
    .set('Accept', 'application/json');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.strictEqual(res.body.status, 'pending');
});

test('Community submission includes reporterId and verification fields', async () => {
  // Ensure contact exists first via journalist apply (pending)
  await request(app).post('/api/journalists/apply').send({
    name: 'Test Journalist',
    email: 'journalist2@example.com',
    phone: '1234567890',
    city: 'Delhi',
    state: 'DL',
    country: 'India',
    organisationName: 'News Co',
    organisationType: 'digital',
    positionTitle: 'Reporter',
    beats: ['politics'],
  });
  const res = await request(app)
    .post('/api/community-reporter/submissions')
    .send({
      name: 'Citizen Reporter',
      email: 'citizen@example.com',
      location: 'Ahmedabad',
      category: 'local',
      headline: 'Test Headline',
      story: 'Test story body content',
    })
    .set('Accept', 'application/json');
  assert.strictEqual(res.statusCode, 201);
  assert.ok(res.body.item.reporterId === null || typeof res.body.item.reporterId === 'string');
  assert.ok(['community', 'journalist'].includes(res.body.item.sourceType));
  assert.ok(['unverified', 'pending', 'verified'].includes(res.body.item.reporterVerificationLevel));
});
