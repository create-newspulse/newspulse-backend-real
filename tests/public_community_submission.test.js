const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const communityAiReview = require('../services/communityAiReview');
communityAiReview.runCommunityAiReview = async () => ({
  aiTitle: null,
  aiBody: null,
  riskScore: 0,
  flags: [],
  policyNotes: null,
  aiSuggestedCategory: null,
  aiSuggestedTags: [],
  aiTipOnlySuggested: false,
});

const app = require('../server');
const CommunitySubmission = require('../models/CommunitySubmission');
const reporterContactService = require('../services/reporterContactService');
const reporterIdentityResolution = require('../services/reporterIdentityResolution.service');

function stubCommunitySubmissionCreate() {
  const originalCreate = CommunitySubmission.create;
  const originalUpsertContact = reporterContactService.upsertReporterContactFromPayload;
  const originalResolveAndAttach = reporterIdentityResolution.resolveAndAttachForSubmission;
  const captured = [];

  CommunitySubmission.create = async (payload) => {
    captured.push(payload);
    return {
      ...payload,
      _id: { toString: () => '507f1f77bcf86cd799439021' },
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
      updatedAt: new Date('2026-08-18T10:00:00.000Z'),
      save: async function save() { return this; },
    };
  };
  reporterContactService.upsertReporterContactFromPayload = async () => ({ contactId: null, contact: null });
  reporterIdentityResolution.resolveAndAttachForSubmission = async () => ({ ok: true });

  return {
    captured,
    restore() {
      CommunitySubmission.create = originalCreate;
      reporterContactService.upsertReporterContactFromPayload = originalUpsertContact;
      reporterIdentityResolution.resolveAndAttachForSubmission = originalResolveAndAttach;
    },
  };
}

test('POST /api/community/submissions accepts public form aliases and stores pending moderation status', async () => {
  const stub = stubCommunitySubmissionCreate();
  try {
    const res = await request(app)
      .post('/api/community/submissions')
      .send({
        fullName: 'Test Reporter',
        email: 'reporter@example.com',
        location: { city: 'Mumbai', state: 'Maharashtra', country: 'India' },
        category: 'other',
        headline: 'Sample Headline',
        story: 'This is a valid story body',
        acceptTerms: true,
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.item.status, 'PENDING_FOUNDER');
    assert.equal(stub.captured[0].reporterName, 'Test Reporter');
    assert.equal(stub.captured[0].category, 'General Tip');
    assert.equal(stub.captured[0].acceptTerms, true);
  } finally {
    stub.restore();
  }
});

test('POST /api/community/submissions stores canonical ageGroup values', async () => {
  const canonicalValues = ['under_18', '18_24', '25_40', '41_plus'];

  for (const ageGroup of canonicalValues) {
    const stub = stubCommunitySubmissionCreate();
    try {
      const res = await request(app)
        .post('/api/community/submissions')
        .send({
          userName: `Reporter ${ageGroup}`,
          email: `${ageGroup}@example.com`,
          city: 'Mumbai',
          category: 'General Tip',
          headline: 'Sample Headline',
          body: 'This is a valid story body',
          ageGroup,
        });

      assert.equal(res.statusCode, 201);
      assert.equal(stub.captured[0].ageGroup, ageGroup);
      assert.equal(stub.captured[0].reporterAgeGroup, ageGroup);
    } finally {
      stub.restore();
    }
  }
});

test('POST /api/community/submissions normalizes legacy mojibake ageGroup labels', async () => {
  const stub = stubCommunitySubmissionCreate();
  try {
    const res = await request(app)
      .post('/api/community/submissions')
      .send({
        userName: 'Legacy Reporter',
        email: 'legacy@example.com',
        city: 'Mumbai',
        category: 'General Tip',
        headline: 'Sample Headline',
        body: 'This is a valid story body',
        ageGroup: '18â€“24',
      });

    assert.equal(res.statusCode, 201);
    assert.equal(stub.captured[0].ageGroup, '18_24');
    assert.equal(stub.captured[0].reporterAgeGroup, '18_24');
  } finally {
    stub.restore();
  }
});

test('POST /api/community/submissions rejects unknown ageGroup with safe diagnostics', async () => {
  const res = await request(app)
    .post('/api/community/submissions')
    .send({
      userName: 'Invalid Reporter',
      email: 'invalid-age@example.com',
      city: 'Mumbai',
      category: 'General Tip',
      headline: 'Sample Headline',
      body: 'This is a valid story body',
      ageGroup: 'middle-school',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.deepEqual(res.body.fields, ['ageGroup']);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'phone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'stack'), false);
});

test('POST /api/community/submissions rejects missing required fields with safe field diagnostics', async () => {
  const res = await request(app)
    .post('/api/community/submissions')
    .send({
      name: '',
      email: '',
      headline: '',
      story: '',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'VALIDATION_ERROR');
  assert.deepEqual(res.body.fields.sort(), ['body', 'category', 'email', 'headline', 'userName']);
  assert.equal(res.body.message, 'Required submission fields are missing or invalid.');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'details'), false);
});

test('POST /api/community/submissions rejects invalid category with enum diagnostics', async () => {
  const res = await request(app)
    .post('/api/community/submissions')
    .send({
      name: 'Test Reporter',
      email: 'reporter@example.com',
      category: 'not-a-real-category',
      headline: 'Sample Headline',
      story: 'This is a valid story body',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'VALIDATION_ERROR');
  assert.deepEqual(res.body.fields, ['category']);
  assert.equal(res.body.fieldErrors[0].code, 'invalid_enum');
  assert.ok(res.body.fieldErrors[0].allowedValues.includes('General Tip'));
});

test('POST /api/community/submissions rejects malformed consent metadata', async () => {
  const res = await request(app)
    .post('/api/community/submissions')
    .send({
      name: 'Test Reporter',
      email: 'reporter@example.com',
      category: 'General Tip',
      headline: 'Sample Headline',
      story: 'This is a valid story body',
      acceptTerms: 'not-sure',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'VALIDATION_ERROR');
  assert.deepEqual(res.body.fields, ['acceptTerms']);
  assert.equal(res.body.fieldErrors[0].code, 'invalid_boolean');
});

test('POST /api/community/submissions ignores extra frontend metadata without 500', async () => {
  const stub = stubCommunitySubmissionCreate();
  try {
    const res = await request(app)
      .post('/api/community/submissions')
      .send({
        reporter: { name: 'Meta Reporter', email: 'meta@example.com' },
        category: 'civic',
        title: 'Metadata headline',
        content: 'Metadata story body',
        reporterAccountId: 'client-reporter-123',
        status: 'APPROVED',
        sourceType: 'journalist',
        reporterVerificationLevel: 'journalist_verified',
        sourceUrl: 'https://example.com/source',
        metadata: { draftId: 'draft-1', clientVersion: 'web-public' },
        consents: {
          truthful: 'true',
          rightsToShare: 'true',
          editorialReviewAllowed: 'true',
          safeContent: 'true',
        },
        mediaUrls: ['https://example.com/photo.jpg'],
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.equal(stub.captured[0].category, 'Civic Issue');
    assert.equal(stub.captured[0].reporterUserId, undefined);
    assert.equal(stub.captured[0].reporterAccountId, undefined);
    assert.equal(stub.captured[0].status, 'PENDING_FOUNDER');
    assert.equal(stub.captured[0].sourceType, 'community');
    assert.equal(stub.captured[0].reporterVerificationLevel, 'unverified');
    assert.equal(stub.captured[0].confirmTruthful, true);
    assert.equal(stub.captured[0].attachments[0].url, 'https://example.com/photo.jpg');
  } finally {
    stub.restore();
  }
});