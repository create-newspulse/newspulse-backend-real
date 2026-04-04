const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ENABLE_TOGGLE_QUERY_IN_TESTS = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.EMAIL_MODE = 'stub';

const FounderFeatureToggles = require('../models/FounderFeatureToggles');
const FeatureToggles = require('../models/FeatureToggles');
const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');
const CommunitySettings = require('../models/CommunitySettings');
const SystemSettings = require('../models/SystemSettings');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const OtpToken = require('../models/OtpToken');

let founderDoc;
let legacyFeatureDoc;
let communityFeatureDoc;
let communitySettingsDoc;
let systemSettingsDoc;
let reporterDoc;
let otpStore;
let submissionStore;
let submissionSeq;

function makeLeanResult(value) {
  return {
    lean: async () => value,
  };
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function buildReporterDoc(data) {
  return {
    ...clone(data),
    save: async function save() {
      const next = clone(this);
      delete next.save;
      reporterDoc = next;
      return this;
    },
  };
}

function buildSubmissionDoc(data) {
  return {
    ...clone(data),
    save: async function save() {
      const next = clone(this);
      delete next.save;
      const index = submissionStore.findIndex((item) => String(item._id) === String(next._id));
      if (index >= 0) {
        submissionStore[index] = next;
      }
      return this;
    },
  };
}

function getPathValue(doc, path) {
  return String(path || '').split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc);
}

function matchesFilter(doc, filter) {
  if (!filter) return true;

  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return Array.isArray(expected) && expected.some((entry) => matchesFilter(doc, entry));
    }

    const actual = getPathValue(doc, key);

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        return actual !== expected.$ne;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
    }

    return String(actual || '') === String(expected || '');
  });
}

function makeQuery(value) {
  const state = {
    value: Array.isArray(value) ? value.map((item) => clone(item)) : clone(value),
    skip: 0,
    limit: null,
  };

  return {
    sort(sortSpec) {
      if (!Array.isArray(state.value)) return this;
      const [[field, direction]] = Object.entries(sortSpec || { createdAt: -1 });
      state.value.sort((left, right) => {
        const leftVal = left && left[field] ? new Date(left[field]).getTime() : 0;
        const rightVal = right && right[field] ? new Date(right[field]).getTime() : 0;
        return direction < 0 ? rightVal - leftVal : leftVal - rightVal;
      });
      return this;
    },
    skip(amount) {
      state.skip = amount;
      return this;
    },
    limit(amount) {
      state.limit = amount;
      return this;
    },
    lean: async function lean() {
      if (!Array.isArray(state.value)) return clone(state.value);
      const slice = state.value.slice(state.skip, state.limit == null ? undefined : state.skip + state.limit);
      return slice.map((item) => clone(item));
    },
    then(resolve, reject) {
      try {
        if (!Array.isArray(state.value)) {
          return Promise.resolve(state.value ? buildSubmissionDoc(state.value) : null).then(resolve, reject);
        }
        const slice = state.value.slice(state.skip, state.limit == null ? undefined : state.skip + state.limit);
        return Promise.resolve(slice.map((item) => buildSubmissionDoc(item))).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  };
}

FounderFeatureToggles.findOne = () => makeLeanResult(founderDoc);
FounderFeatureToggles.findOneAndUpdate = async (_filter, update) => {
  const patch = {
    ...(update && update.$setOnInsert ? update.$setOnInsert : {}),
    ...(update && update.$set ? update.$set : {}),
  };
  founderDoc = {
    key: 'community_feature_toggles',
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-05T10:00:00.000Z'),
    ...founderDoc,
    ...patch,
  };
  return founderDoc;
};
FeatureToggles.findOne = () => makeLeanResult(legacyFeatureDoc);
CommunityFeatureSettings.findOne = () => makeLeanResult(communityFeatureDoc);
CommunitySettings.findOne = () => makeLeanResult(communitySettingsDoc);
SystemSettings.findOne = () => makeLeanResult(systemSettingsDoc);

ReporterContact.findOne = async (filter) => {
  if (!reporterDoc) return null;
  const email = normalizeEmail(reporterDoc.email || reporterDoc.emailLower);
  const candidates = [];
  if (filter && Array.isArray(filter.$or)) {
    filter.$or.forEach((entry) => {
      if (entry.email) candidates.push(normalizeEmail(entry.email));
      if (entry.emailLower) candidates.push(normalizeEmail(entry.emailLower));
    });
  }
  if (candidates.length && !candidates.includes(email)) return null;
  return buildReporterDoc(reporterDoc);
};

ReporterContact.findById = async (id) => {
  if (!reporterDoc || String(reporterDoc._id) !== String(id)) return null;
  return buildReporterDoc(reporterDoc);
};

ReporterContact.findOneAndUpdate = async (filter, update) => {
  if (!reporterDoc) return null;
  if (filter && filter._id && String(filter._id) !== String(reporterDoc._id)) return null;
  if (update && update.$set) {
    reporterDoc = { ...reporterDoc, ...clone(update.$set) };
  }
  return buildReporterDoc(reporterDoc);
};

OtpToken.updateMany = async (filter, update) => {
  otpStore = otpStore.map((item) => {
    if (normalizeEmail(item.email) !== normalizeEmail(filter.email)) return item;
    if (item.purpose !== filter.purpose) return item;
    if (filter.used !== undefined && item.used !== filter.used) return item;
    return { ...item, ...(update && update.$set ? clone(update.$set) : {}) };
  });
  return { acknowledged: true };
};

OtpToken.create = async (payload) => {
  const doc = {
    _id: String(otpStore.length + 1),
    createdAt: new Date(),
    ...clone(payload),
    save: async function save() {
      const next = clone(this);
      delete next.save;
      const index = otpStore.findIndex((item) => String(item._id) === String(next._id));
      if (index >= 0) otpStore[index] = next;
      return this;
    },
  };
  otpStore.push(clone({ ...doc, save: undefined }));
  return doc;
};

OtpToken.findOne = (filter) => {
  const matches = otpStore.filter((item) => {
    return normalizeEmail(item.email) === normalizeEmail(filter.email)
      && item.purpose === filter.purpose
      && item.used === filter.used;
  });
  return {
    sort: async () => {
      const latest = matches.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] || null;
      if (!latest) return null;
      return {
        ...clone(latest),
        save: async function save() {
          const next = clone(this);
          delete next.save;
          const index = otpStore.findIndex((item) => String(item._id) === String(next._id));
          if (index >= 0) otpStore[index] = next;
          return this;
        },
      };
    },
  };
};

CommunitySubmission.find = (filter) => {
  const matches = submissionStore.filter((item) => matchesFilter(item, filter));
  return makeQuery(matches);
};

CommunitySubmission.findOne = (filter) => {
  const match = submissionStore.find((item) => matchesFilter(item, filter)) || null;
  return makeQuery(match);
};

CommunitySubmission.updateMany = async (filter, update) => {
  submissionStore = submissionStore.map((item) => {
    if (!matchesFilter(item, filter)) return item;
    return { ...item, ...(update && update.$set ? clone(update.$set) : {}) };
  });
  return { acknowledged: true };
};

CommunitySubmission.create = async (payload) => {
  const id = `507f1f77bcf86cd7994390${String(submissionSeq).padStart(2, '0')}`;
  submissionSeq += 1;
  const now = new Date(`2026-04-05T10:${String(submissionSeq).padStart(2, '0')}:00.000Z`);
  const doc = {
    _id: id,
    createdAt: now,
    updatedAt: now,
    isDeleted: false,
    ...clone(payload),
  };
  submissionStore.unshift(doc);
  return buildSubmissionDoc(doc);
};

const reporterContactService = require('../services/reporterContactService');
reporterContactService.upsertReporterContactFromPayload = async () => ({ contact: buildReporterDoc(reporterDoc), contactId: reporterDoc._id });
reporterContactService.upsertReporterContactFromSubmission = async () => ({ contact: buildReporterDoc(reporterDoc), contactId: reporterDoc._id });

const reporterIdentityResolutionService = require('../services/reporterIdentityResolution.service');
reporterIdentityResolutionService.resolveAndAttachForSubmission = async () => ({ profileId: null });

const app = require('../server');

test.beforeEach(() => {
  try {
    mongoose.connection.readyState = 1;
    mongoose.connection.name = 'newspulse-test';
  } catch (_) {}
  founderDoc = {
    key: 'community_feature_toggles',
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-05T10:00:00.000Z'),
  };
  legacyFeatureDoc = {
    communityReporterClosed: false,
    reporterPortalClosed: false,
    updatedAt: new Date('2026-04-04T10:00:00.000Z'),
  };
  communityFeatureDoc = {
    key: 'community',
    communityReporterEnabled: true,
    reporterPortalEnabled: true,
    allowNewSubmissions: true,
    allowMyStoriesPortal: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
  communitySettingsDoc = {
    communityReporterEnabled: true,
    allowNewSubmissions: true,
    allowMyStoriesPortal: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
  systemSettingsDoc = {
    communityMyStoriesEnabled: true,
    communityReporterEnabled: true,
    reporterPortalEnabled: true,
    allowNewSubmissions: true,
    allowJournalistApplications: true,
    safeModeManualReviewOnly: false,
  };
  reporterDoc = {
    _id: '507f191e810c19729de860aa',
    fullName: 'Reporter One',
    email: 'reporter@example.com',
    emailLower: 'reporter@example.com',
    reporterType: 'community',
    verificationLevel: 'community_default',
    portalAccessEnabled: true,
    portalAuthVersion: 0,
    status: 'active',
    lastPortalLoginAt: null,
  };
  otpStore = [];
  submissionSeq = 10;
  submissionStore = [
    {
      _id: '507f1f77bcf86cd799439011',
      reporterId: reporterDoc._id,
      reporterEmail: 'reporter@example.com',
      reporterEmailNorm: 'reporter@example.com',
      email: 'reporter@example.com',
      headline: 'Existing Draft',
      body: 'Draft body',
      category: 'local',
      status: 'DRAFT',
      createdAt: new Date('2026-04-05T09:00:00.000Z'),
      updatedAt: new Date('2026-04-05T09:00:00.000Z'),
      isDeleted: false,
      contact: { email: 'reporter@example.com', name: 'Reporter One' },
      attachments: [],
    },
    {
      _id: '507f1f77bcf86cd799439012',
      reporterId: reporterDoc._id,
      reporterEmail: 'reporter@example.com',
      reporterEmailNorm: 'reporter@example.com',
      email: 'reporter@example.com',
      headline: 'Approved Story',
      body: 'Approved body',
      category: 'city',
      status: 'APPROVED',
      createdAt: new Date('2026-04-04T09:00:00.000Z'),
      updatedAt: new Date('2026-04-04T09:00:00.000Z'),
      isDeleted: false,
      contact: { email: 'reporter@example.com', name: 'Reporter One' },
      attachments: [],
    },
    {
      _id: '507f1f77bcf86cd799439013',
      reporterId: '507f191e810c19729de860bb',
      reporterEmail: 'other@example.com',
      reporterEmailNorm: 'other@example.com',
      email: 'other@example.com',
      headline: 'Other Reporter Story',
      body: 'Other body',
      category: 'world',
      status: 'REJECTED',
      createdAt: new Date('2026-04-03T09:00:00.000Z'),
      updatedAt: new Date('2026-04-03T09:00:00.000Z'),
      isDeleted: false,
      contact: { email: 'other@example.com', name: 'Other Reporter' },
      attachments: [],
    },
  ];
});

test('reporter portal OTP login, session, and own submissions are scoped to reporter identity', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.strictEqual(otpRes.body.ok, true);
  assert.ok(otpRes.body.devCode);

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.ok(verifyRes.body.token);
  assert.deepStrictEqual(verifyRes.body.summary, {
    totalSubmissions: 2,
    pending: 1,
    approved: 1,
    rejected: 0,
    published: 0,
  });

  const sessionRes = await request(app)
    .get('/api/reporter-portal/auth/session')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.reporter.email, 'reporter@example.com');
  assert.strictEqual(sessionRes.body.summary.totalSubmissions, 2);

  const submissionsRes = await request(app)
    .get('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.items.length, 2);
  assert.ok(submissionsRes.body.items.every((item) => item.id !== '507f1f77bcf86cd799439013'));

  const dashboardRes = await request(app)
    .get('/api/reporter-portal/dashboard/summary')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(dashboardRes.statusCode, 200);
  assert.deepStrictEqual(dashboardRes.body.summary, {
    totalSubmissions: 2,
    pending: 1,
    approved: 1,
    rejected: 0,
    published: 0,
  });
});

test('reporter portal can create and edit only allowed submissions on shared CommunitySubmission records', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });
  const token = verifyRes.body.token;

  const createRes = await request(app)
    .post('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${token}`)
    .send({
      action: 'draft',
      headline: 'Portal Draft',
      story: 'Draft story body',
      category: 'district',
    });

  assert.strictEqual(createRes.statusCode, 201);
  assert.strictEqual(createRes.body.item.portalStatus, 'DRAFT');
  assert.strictEqual(createRes.body.item.rawStatus, 'DRAFT');

  const createdId = createRes.body.item.id;
  const storedCreated = submissionStore.find((item) => String(item._id) === String(createdId));
  assert.strictEqual(String(storedCreated.reporterId), reporterDoc._id);
  assert.strictEqual(storedCreated.reporterEmailNorm, 'reporter@example.com');

  const patchRes = await request(app)
    .patch(`/api/reporter-portal/submissions/${createdId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      action: 'submit',
      headline: 'Portal Draft Final',
      story: 'Ready for review',
    });

  assert.strictEqual(patchRes.statusCode, 200);
  assert.strictEqual(patchRes.body.item.portalStatus, 'SUBMITTED');
  assert.strictEqual(patchRes.body.item.rawStatus, 'SUBMITTED');

  const forbiddenEditRes = await request(app)
    .patch('/api/reporter-portal/submissions/507f1f77bcf86cd799439012')
    .set('Authorization', `Bearer ${token}`)
    .send({ headline: 'Should fail' });

  assert.strictEqual(forbiddenEditRes.statusCode, 409);
  assert.strictEqual(forbiddenEditRes.body.code, 'SUBMISSION_NOT_EDITABLE');
});

test('reporter portal routes are denied when the reporter portal toggle is closed', async () => {
  founderDoc.reporterPortalClosed = true;

  const closedRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  assert.strictEqual(closedRes.statusCode, 503);
  assert.strictEqual(closedRes.body.code, 'REPORTER_PORTAL_CLOSED');
});

test('legacy reporter story endpoints no longer allow unauthenticated email-based portal access', async () => {
  const res = await request(app)
    .get('/api/community-reporter/my-stories')
    .query({ email: 'reporter@example.com' });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'REPORTER_AUTH_REQUIRED');
});

test('reporter logout invalidates the active portal token', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });
  const token = verifyRes.body.token;

  const logoutRes = await request(app)
    .post('/api/reporter-portal/auth/logout')
    .set('Authorization', `Bearer ${token}`);

  assert.strictEqual(logoutRes.statusCode, 200);
  assert.strictEqual(logoutRes.body.ok, true);
  assert.strictEqual(reporterDoc.portalAuthVersion, 1);

  const sessionRes = await request(app)
    .get('/api/reporter-portal/auth/session')
    .set('Authorization', `Bearer ${token}`);

  assert.strictEqual(sessionRes.statusCode, 401);
  assert.strictEqual(sessionRes.body.code, 'REPORTER_AUTH_REQUIRED');
});

test('reporter OTP request and verification attempts are rate limited', async () => {
  reporterDoc.email = 'ratelimit@example.com';
  reporterDoc.emailLower = 'ratelimit@example.com';

  let lastRequestRes = null;
  for (let index = 0; index < 9; index += 1) {
    lastRequestRes = await request(app)
      .post('/api/reporter-portal/auth/request-login-otp')
      .send({ email: 'ratelimit@example.com' });
  }

  assert.strictEqual(lastRequestRes.statusCode, 429);
  assert.strictEqual(lastRequestRes.body.code, 'OTP_REQUEST_RATE_LIMITED');

  reporterDoc.email = 'verifylimit@example.com';
  reporterDoc.emailLower = 'verifylimit@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'verifylimit@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  let lastVerifyRes = null;
  for (let index = 0; index < 11; index += 1) {
    lastVerifyRes = await request(app)
      .post('/api/reporter-portal/auth/verify-login-otp')
      .send({ email: 'verifylimit@example.com', otp: '000000' });
  }

  assert.strictEqual(lastVerifyRes.statusCode, 429);
  assert.strictEqual(lastVerifyRes.body.code, 'OTP_VERIFY_RATE_LIMITED');
});

test('reporter email change requires OTP verification and invalidates old session', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });
  const token = verifyRes.body.token;

  const requestChangeRes = await request(app)
    .post('/api/reporter-portal/profile/email/request-change')
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'reporter.new@example.com' });

  assert.strictEqual(requestChangeRes.statusCode, 200);
  assert.strictEqual(requestChangeRes.body.ok, true);
  assert.strictEqual(reporterDoc.pendingPortalEmail, 'reporter.new@example.com');
  assert.ok(requestChangeRes.body.devCode);

  const confirmRes = await request(app)
    .post('/api/reporter-portal/profile/email/confirm-change')
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'reporter.new@example.com', otp: requestChangeRes.body.devCode });

  assert.strictEqual(confirmRes.statusCode, 200);
  assert.strictEqual(confirmRes.body.ok, true);
  assert.strictEqual(confirmRes.body.reverifyRequired, true);
  assert.strictEqual(reporterDoc.email, 'reporter.new@example.com');
  assert.strictEqual(reporterDoc.emailLower, 'reporter.new@example.com');
  assert.strictEqual(reporterDoc.pendingPortalEmail, null);
  assert.strictEqual(reporterDoc.portalAuthVersion, 1);

  const oldSessionRes = await request(app)
    .get('/api/reporter-portal/auth/session')
    .set('Authorization', `Bearer ${token}`);

  assert.strictEqual(oldSessionRes.statusCode, 401);
  assert.strictEqual(oldSessionRes.body.code, 'REPORTER_AUTH_REQUIRED');

  const newOtpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter.new@example.com' });

  assert.strictEqual(newOtpRes.statusCode, 200);
  const newVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter.new@example.com', otp: newOtpRes.body.devCode });

  assert.strictEqual(newVerifyRes.statusCode, 200);
  assert.strictEqual(newVerifyRes.body.reporter.email, 'reporter.new@example.com');
});