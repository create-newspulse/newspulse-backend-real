const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
process.env.NODE_ENV = 'test';
require('dotenv').config();

// Minimal env required for admin auth middleware (uses JWT_SECRET)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

// Monkey-patch ReporterContact & CommunitySubmission DB methods to avoid real Mongo requirement in NODE_ENV=test.
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

let storedContacts = new Map(); // key: email -> contact object
let submissions = []; // store submission docs

function _normEmail(value) {
  const e = String(value || '').trim().toLowerCase();
  return e || null;
}

function _docEmail(doc) {
  return _normEmail(doc?.reporterEmailNorm || doc?.reporterEmail || doc?.email || doc?.contact?.email);
}

function _matchesEmailQuery(doc, q) {
  if (!q) return true;
  const target = _docEmail(doc);
  if (!target) return false;

  if (q.$or && Array.isArray(q.$or)) {
    for (const clause of q.$or) {
      if (clause && typeof clause === 'object') {
        const clauseVal = clause.reporterEmailNorm || clause.reporterEmail || clause.email || clause['contact.email'];
        if (_normEmail(clauseVal) === target) return true;
      }
    }
    return false;
  }

  if (q.email) return _normEmail(q.email) === target;
  if (q.reporterEmailNorm) return _normEmail(q.reporterEmailNorm) === target;
  if (q.reporterEmail) return _normEmail(q.reporterEmail) === target;
  return true;
}

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
  const statusIn = q && q.status && q.status.$in ? q.status.$in : null;
  return submissions.filter(s => {
    if (q && q.reporterId && String(s.reporterId) !== String(q.reporterId)) return false;
    if (!_matchesEmailQuery(s, q)) return false;
    if (statusIn && !statusIn.includes(s.status)) return false;
    return true;
  }).length;
};

CommunitySubmission.findOne = (q) => {
  return {
    sort: (_sort) => ({
      lean: async () => {
        const hits = submissions
          .filter(s => _matchesEmailQuery(s, q))
          .sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt)));
        return hits[0] || null;
      },
    }),
  };
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
  assert.ok(typeof res.body.reporterId === 'string');
  assert.strictEqual(res.body.message, 'Application received');
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
  assert.ok(['unverified', 'journalist_pending', 'journalist_verified'].includes(res.body.item.reporterVerificationLevel));
});

test('Phase-1 /api/community-reporter/submit upserts contact and returns string id', async () => {
  const res = await request(app)
    .post('/api/community-reporter/submit')
    .send({
      name: 'Kiran Parmar',
      email: 'krn85397@gmail.com',
      location: 'Ahmedabad, Gujarat',
      headline: 'Hello',
      story: 'Body',
      ageGroup: '18-24',
    })
    .set('Accept', 'application/json');

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(typeof res.body.id, 'string');
  assert.ok(storedContacts.has('krn85397@gmail.com'));
});
