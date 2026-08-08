const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const YouthPulseContributor = require('../models/YouthPulseContributor');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');

function stubYouthPulseStorage(submissionId) {
  const originalFindOne = YouthPulseContributor.findOne;
  const originalContributorCreate = YouthPulseContributor.create;
  const originalSubmissionCreate = YouthPulseSubmission.create;
  const originalAggregate = YouthPulseSubmission.aggregate;
  const originalFindByIdAndUpdate = YouthPulseContributor.findByIdAndUpdate;

  YouthPulseContributor.findOne = async () => null;
  YouthPulseContributor.create = async (payload) => ({
    _id: '507f1f77bcf86cd799439099',
    ...payload,
    save: async function save() { return this; },
  });
  YouthPulseSubmission.create = async (payload) => ({
    _id: submissionId,
    ...payload,
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  });
  YouthPulseSubmission.aggregate = async () => [];
  YouthPulseContributor.findByIdAndUpdate = async () => null;

  return () => {
    YouthPulseContributor.findOne = originalFindOne;
    YouthPulseContributor.create = originalContributorCreate;
    YouthPulseSubmission.create = originalSubmissionCreate;
    YouthPulseSubmission.aggregate = originalAggregate;
    YouthPulseContributor.findByIdAndUpdate = originalFindByIdAndUpdate;
  };
}

test('POST /api/community/youth-pulse/submissions rejects incomplete consent', async () => {
  const res = await request(app)
    .post('/api/community/youth-pulse/submissions')
    .send({
      fullName: 'Asha Patel',
      email: 'asha@example.com',
      mobile: '+91 9999999999',
      city: 'Ahmedabad',
      state: 'Gujarat',
      track: 'student-voices',
      submissionType: 'reported_story',
      headline: 'Campus issue',
      storyBody: 'Story body',
      originalLanguage: 'en',
      confirmTruthful: true,
      confirmRightsToShare: true,
      confirmEditorialReviewAllowed: false,
      confirmNoUnsafeFalseAbusiveContent: true,
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.includes('all consent fields must be accepted'));
});

test('POST /api/community/youth-pulse/submissions stores moderated Youth Pulse submission only', async () => {
  const restore = stubYouthPulseStorage('507f1f77bcf86cd799439011');

  try {
    const res = await request(app)
      .post('/api/community/youth-pulse/submissions')
      .send({
        fullName: 'Asha Patel',
        email: 'asha@example.com',
        mobile: '+91 9999999999',
        college: 'Gujarat University',
        city: 'Ahmedabad',
        state: 'Gujarat',
        track: 'student-voices',
        submissionType: 'reported_story',
        headline: '<b>Campus issue</b>',
        storyBody: 'Student council raised a hostel safety issue.',
        originalLanguage: 'en',
        firstHandClaim: true,
        optionalSourceLinks: ['https://example.com/source'],
        optionalAttachmentUrls: ['https://example.com/attachment.pdf'],
        confirmTruthful: true,
        confirmRightsToShare: true,
        confirmEditorialReviewAllowed: true,
        confirmNoUnsafeFalseAbusiveContent: true,
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.submissionId, '507f1f77bcf86cd799439011');
    assert.equal(res.body.item.status, 'new');
    assert.equal(res.body.item.track, 'student-voices');
    assert.equal(res.body.item.sourceType, 'youth_pulse');
    assert.equal(res.body.item.articleLinked, false);
    assert.equal(res.body.item.headline, 'Campus issue');
  } finally {
    restore();
  }
});

test('POST /api/community/youth-pulse/submissions accepts current public form aliases', async () => {
  const restore = stubYouthPulseStorage('507f1f77bcf86cd799439012');

  try {
    const res = await request(app)
      .post('/api/community/youth-pulse/submissions')
      .send({
        fullName: 'Riya Shah',
        email: 'riya@example.com',
        mobile: '+91 8888888888',
        college: 'St Xavier College',
        city: 'Vadodara',
        state: 'Gujarat',
        track: 'student-voices',
        submissionType: 'reported_story',
        headline: 'Student union raises transport issue',
        story: 'Students said the late bus schedule is affecting attendance.',
        knowledgeSource: 'first-hand',
        consents: {
          truthful: true,
          rightsToShare: true,
          editorialReviewAllowed: true,
          noUnsafeFalseAbusiveContent: true,
        },
      });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.submissionId, '507f1f77bcf86cd799439012');
    assert.equal(res.body.item.status, 'new');
    assert.equal(res.body.item.track, 'student-voices');
    assert.equal(res.body.item.sourceType, 'youth_pulse');
    assert.equal(res.body.item.headline, 'Student union raises transport issue');
  } finally {
    restore();
  }
});