const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ENABLE_TOGGLE_QUERY_IN_TESTS = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.EMAIL_MODE = 'stub';
process.env.REPORTER_OTP_RESEND_COOLDOWN_MS = '0';

const FounderFeatureToggles = require('../models/FounderFeatureToggles');
const FeatureToggles = require('../models/FeatureToggles');
const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');
const CommunitySettings = require('../models/CommunitySettings');
const SystemSettings = require('../models/SystemSettings');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const OtpToken = require('../models/OtpToken');
const reporterPortalRouter = require('../routes/reporterPortal');

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

    if (expected instanceof RegExp) {
      return expected.test(String(actual || ''));
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        return actual !== expected.$ne;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$lte')) {
        return actual !== undefined && new Date(actual).getTime() <= new Date(expected.$lte).getTime();
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$lt')) {
        return actual !== undefined && new Date(actual).getTime() < new Date(expected.$lt).getTime();
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$gte')) {
        return actual !== undefined && new Date(actual).getTime() >= new Date(expected.$gte).getTime();
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$gt')) {
        return actual !== undefined && new Date(actual).getTime() > new Date(expected.$gt).getTime();
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        return Array.isArray(expected.$in) && expected.$in.some((value) => String(actual || '') === String(value || ''));
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
  if (!reporterDoc) {
    const email = normalizeEmail(
      (filter && filter.email)
      || (update && update.$setOnInsert && update.$setOnInsert.email)
      || (update && update.$set && update.$set.emailLower)
      || ''
    );
    reporterDoc = {
      _id: '507f191e810c19729de860cc',
      fullName: 'Reporter',
      email,
      emailLower: email,
      reporterType: 'community',
      verificationLevel: 'community_default',
      portalAccessEnabled: true,
      portalAuthVersion: 0,
      status: 'active',
      lastPortalLoginAt: null,
    };
  }
  if (filter && filter._id && String(filter._id) !== String(reporterDoc._id)) return null;
  if (update && update.$setOnInsert) {
    reporterDoc = { ...clone(update.$setOnInsert), ...reporterDoc };
  }
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
  const matches = otpStore.filter((item) => matchesFilter(item, filter));
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

OtpToken.find = (filter) => {
  const matches = otpStore.filter((item) => matchesFilter(item, filter));
  return {
    sort(sortSpec) {
      const [[field, direction]] = Object.entries(sortSpec || { createdAt: -1 });
      matches.sort((left, right) => {
        const leftVal = left && left[field] ? new Date(left[field]).getTime() : 0;
        const rightVal = right && right[field] ? new Date(right[field]).getTime() : 0;
        return direction < 0 ? rightVal - leftVal : leftVal - rightVal;
      });
      return this;
    },
    limit(amount) {
      this._limit = amount;
      return this;
    },
    then(resolve, reject) {
      try {
        const slice = matches.slice(0, this._limit == null ? matches.length : this._limit).map((item) => ({
          ...clone(item),
          save: async function save() {
            const next = clone(this);
            delete next.save;
            const index = otpStore.findIndex((entry) => String(entry._id) === String(next._id));
            if (index >= 0) otpStore[index] = next;
            return this;
          },
        }));
        return Promise.resolve(slice).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
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
  if (typeof reporterPortalRouter.resetRateLimitsForTests === 'function') {
    reporterPortalRouter.resetRateLimitsForTests();
  }
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

test('reporter portal auth session and submissions work with localhost cookie auth', async () => {
  const agent = request.agent(app);

  const otpRes = await agent
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const verifyRes = await agent
    .post('/api/reporter-portal/auth/verify-login-otp')
    .set('Origin', 'http://localhost:5173')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.ok(Array.isArray(verifyRes.headers['set-cookie']));
  assert.ok(verifyRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_session=')));
  assert.ok(verifyRes.headers['set-cookie'].some((value) => value.includes('HttpOnly')));
  assert.ok(verifyRes.headers['set-cookie'].some((value) => value.includes('SameSite=Lax')));
  assert.ok(!verifyRes.headers['set-cookie'].some((value) => value.includes('Secure')));

  const sessionRes = await agent
    .get('/api/reporter-portal/auth/session')
    .set('Origin', 'http://localhost:5173');

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.reporter.email, 'reporter@example.com');

  const submissionsRes = await agent
    .get('/api/reporter-portal/submissions')
    .set('Origin', 'http://localhost:5173');

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.total, 2);
});

test('reporter auth compatibility routes keep cookie auth stable when host is 127.0.0.1 and origin is localhost', async () => {
  const agent = request.agent(app);

  const otpRes = await agent
    .post('/api/reporter-auth/request-code')
    .set('Host', '127.0.0.1:5000')
    .set('Origin', 'http://localhost:5173')
    .send({ email: 'reporter@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const verifyRes = await agent
    .post('/api/reporter-auth/verify-code')
    .set('Host', '127.0.0.1:5000')
    .set('Origin', 'http://localhost:5173')
    .send({ email: 'reporter@example.com', code: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.ok(Array.isArray(verifyRes.headers['set-cookie']));
  assert.ok(verifyRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_session=')));
  assert.ok(verifyRes.headers['set-cookie'].some((value) => value.includes('reporter_portal.sid=')));

  const sessionRes = await agent
    .get('/api/reporter-auth/session')
    .set('Host', '127.0.0.1:5000')
    .set('Origin', 'http://localhost:5173');

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.reporter.email, 'reporter@example.com');

  const dashboardRes = await agent
    .get('/api/reporter-auth/dashboard/summary')
    .set('Host', '127.0.0.1:5000')
    .set('Origin', 'http://localhost:5173');

  assert.strictEqual(dashboardRes.statusCode, 200);

  const submissionsRes = await agent
    .get('/api/reporter-auth/submissions')
    .set('Host', '127.0.0.1:5000')
    .set('Origin', 'http://localhost:5173');

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.total, 2);
});

test('reporter auth compatibility routes map to the secure reporter portal flow', async () => {
  const agent = request.agent(app);

  const otpRes = await agent
    .post('/api/reporter-auth/request-code')
    .send({ email: 'reporter@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.strictEqual(otpRes.body.ok, true);
  assert.ok(otpRes.body.devCode);
  assert.ok(otpRes.body.emailMasked);

  const verifyRes = await agent
    .post('/api/reporter-auth/verify-code')
    .send({ email: 'reporter@example.com', code: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.ok(verifyRes.body.token);

  const sessionRes = await agent
    .get('/api/reporter-auth/session')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.ok, true);
  assert.strictEqual(sessionRes.body.reporter.email, 'reporter@example.com');

  const compatDashboardRes = await request(app)
    .get('/api/reporter-auth/dashboard/summary')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(compatDashboardRes.statusCode, 200);
  assert.deepStrictEqual(compatDashboardRes.body.summary, {
    totalSubmissions: 2,
    pending: 1,
    approved: 1,
    rejected: 0,
    published: 0,
  });

  const compatSubmissionsRes = await request(app)
    .get('/api/reporter-auth/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(compatSubmissionsRes.statusCode, 200);
  assert.strictEqual(compatSubmissionsRes.body.items.length, 2);
  assert.ok(compatSubmissionsRes.body.items.every((item) => item.id !== '507f1f77bcf86cd799439013'));

  const logoutRes = await request(app)
    .post('/api/reporter-auth/logout')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(logoutRes.statusCode, 200);
  assert.strictEqual(logoutRes.body.ok, true);

  const expiredSessionRes = await request(app)
    .get('/api/reporter-auth/session')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(expiredSessionRes.statusCode, 401);
  assert.strictEqual(expiredSessionRes.body.code, 'REPORTER_SESSION_MISSING');
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
      category: 'Regional',
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

test('reporter portal submission detail stays scoped to the verified reporter identity', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });
  const token = verifyRes.body.token;

  const ownDetailRes = await request(app)
    .get('/api/reporter-portal/submissions/507f1f77bcf86cd799439011')
    .set('Authorization', `Bearer ${token}`);

  assert.strictEqual(ownDetailRes.statusCode, 200);
  assert.strictEqual(ownDetailRes.body.ok, true);
  assert.strictEqual(ownDetailRes.body.item.id, '507f1f77bcf86cd799439011');

  const otherDetailRes = await request(app)
    .get('/api/reporter-portal/submissions/507f1f77bcf86cd799439013')
    .set('Authorization', `Bearer ${token}`);

  assert.strictEqual(otherDetailRes.statusCode, 404);
  assert.strictEqual(otherDetailRes.body.code, 'SUBMISSION_NOT_FOUND');
});

test('reporter portal rejects unsupported submission categories on create', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  const createRes = await request(app)
    .post('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`)
    .send({
      action: 'draft',
      headline: 'Bad Category Draft',
      story: 'Draft story body',
      category: 'district',
    });

  assert.strictEqual(createRes.statusCode, 400);
  assert.strictEqual(createRes.body.code, 'VALIDATION_FAILED');
});

test('reporter profile update allows safe fields only and blocks direct email change without reverification', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });
  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });
  const token = verifyRes.body.token;

  const updateRes = await request(app)
    .patch('/api/reporter-portal/profile')
    .set('Authorization', `Bearer ${token}`)
    .send({
      fullName: 'Reporter One Updated',
      phone: '+91-9000000000',
      country: 'India',
      stateName: 'Gujarat',
      districtName: 'Rajkot',
      cityTownVillage: 'Rajkot',
    });

  assert.strictEqual(updateRes.statusCode, 200);
  assert.strictEqual(updateRes.body.ok, true);
  assert.strictEqual(updateRes.body.profile.fullName, 'Reporter One Updated');
  assert.strictEqual(updateRes.body.profile.phone, '+91-9000000000');
  assert.strictEqual(reporterDoc.fullName, 'Reporter One Updated');
  assert.strictEqual(reporterDoc.phoneFull, '+91-9000000000');

  const blockedEmailChangeRes = await request(app)
    .patch('/api/reporter-portal/profile')
    .set('Authorization', `Bearer ${token}`)
    .send({ email: 'blocked-change@example.com' });

  assert.strictEqual(blockedEmailChangeRes.statusCode, 400);
  assert.strictEqual(blockedEmailChangeRes.body.code, 'EMAIL_REVERIFICATION_REQUIRED');
  assert.strictEqual(reporterDoc.email, 'reporter@example.com');
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
  assert.strictEqual(res.body.code, 'REPORTER_SESSION_MISSING');
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
  assert.strictEqual(sessionRes.body.code, 'REPORTER_SESSION_MISSING');
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

test('reporter OTP resend immediately replaces the prior active challenge', async () => {
  reporterDoc.email = 'cooldown@example.com';
  reporterDoc.emailLower = 'cooldown@example.com';

  const firstRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'cooldown@example.com' });

  assert.strictEqual(firstRes.statusCode, 200);
  assert.ok(firstRes.body.devCode);

  const secondRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'cooldown@example.com' });

  assert.strictEqual(secondRes.statusCode, 200);
  assert.ok(secondRes.body.devCode);
  assert.notStrictEqual(firstRes.body.devCode, secondRes.body.devCode);

  const oldVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'cooldown@example.com', otp: firstRes.body.devCode });

  assert.strictEqual(oldVerifyRes.statusCode, 400);
  assert.strictEqual(oldVerifyRes.body.code, 'OTP_REPLACED');

  const newVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'cooldown@example.com', otp: secondRes.body.devCode });

  assert.strictEqual(newVerifyRes.statusCode, 200);
  assert.strictEqual(newVerifyRes.body.ok, true);
});

test('reporter OTP resend replaces the older challenge and returns a clear replaced-code failure', async () => {
  reporterDoc.email = 'replace@example.com';
  reporterDoc.emailLower = 'replace@example.com';

  const firstRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'replace@example.com' });

  assert.strictEqual(firstRes.statusCode, 200);
  assert.ok(firstRes.body.devCode);

  const secondRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'replace@example.com' });

  assert.strictEqual(secondRes.statusCode, 200);
  assert.ok(secondRes.body.devCode);
  assert.notStrictEqual(firstRes.body.devCode, secondRes.body.devCode);

  const oldVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'replace@example.com', otp: firstRes.body.devCode });

  assert.strictEqual(oldVerifyRes.statusCode, 400);
  assert.strictEqual(oldVerifyRes.body.code, 'OTP_REPLACED');

  const newVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'replace@example.com', otp: secondRes.body.devCode });

  assert.strictEqual(newVerifyRes.statusCode, 200);
  assert.strictEqual(newVerifyRes.body.ok, true);
});

test('reporter OTP keeps the latest challenge active after a failed verification attempt', async () => {
  reporterDoc.email = 'retry@example.com';
  reporterDoc.emailLower = 'retry@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'retry@example.com' });

  const badVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'retry@example.com', otp: '000000' });

  assert.strictEqual(badVerifyRes.statusCode, 400);
  assert.strictEqual(badVerifyRes.body.code, 'INVALID_OTP');

  const goodVerifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'retry@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(goodVerifyRes.statusCode, 200);
  assert.strictEqual(goodVerifyRes.body.ok, true);
});

test('reporter OTP verify succeeds even when a legacy reporter document save would fail validation', async () => {
  reporterDoc.email = 'legacysave@example.com';
  reporterDoc.emailLower = 'legacysave@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'legacysave@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(otpRes.body.devCode);

  const originalFindOne = ReporterContact.findOne;
  try {
    ReporterContact.findOne = async (filter) => {
      const doc = await originalFindOne(filter);
      if (!doc) return null;
      doc.save = async () => {
        throw new Error('legacy validation failure');
      };
      return doc;
    };

    const verifyRes = await request(app)
      .post('/api/reporter-portal/auth/verify-login-otp')
      .send({ email: 'legacysave@example.com', otp: otpRes.body.devCode });

    assert.strictEqual(verifyRes.statusCode, 200);
    assert.strictEqual(verifyRes.body.ok, true);
    assert.strictEqual(reporterDoc.email, 'legacysave@example.com');
    assert.ok(reporterDoc.lastPortalLoginAt);
  } finally {
    ReporterContact.findOne = originalFindOne;
  }
});

test('reporter OTP verification survives in-memory reset because the challenge is stored in the database model', async () => {
  reporterDoc.email = 'restartsafe@example.com';
  reporterDoc.emailLower = 'restartsafe@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'restartsafe@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(otpRes.body.devCode);

  if (typeof reporterPortalRouter.resetRateLimitsForTests === 'function') {
    reporterPortalRouter.resetRateLimitsForTests();
  }

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'restartsafe@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.ok, true);
});

test('reporter-auth compat session returns pending challenge state during the OTP window', async () => {
  const agent = request.agent(app);
  reporterDoc.email = 'compat.pending@example.com';
  reporterDoc.emailLower = 'compat.pending@example.com';

  const otpRes = await agent
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.pending@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const sessionRes = await agent
    .get('/api/reporter-auth/session');

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.ok, true);
  assert.strictEqual(sessionRes.body.authenticated, false);
  assert.strictEqual(sessionRes.body.challenge.email, 'compat.pending@example.com');
  assert.strictEqual(sessionRes.body.challenge.status, 'pending');
});

test('reporter-auth compat challenge-session returns pending challenge state during the OTP window', async () => {
  const agent = request.agent(app);
  reporterDoc.email = 'compat.challenge@example.com';
  reporterDoc.emailLower = 'compat.challenge@example.com';

  const otpRes = await agent
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.challenge@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const challengeSessionRes = await agent
    .get('/api/reporter-auth/challenge-session');

  assert.strictEqual(challengeSessionRes.statusCode, 200);
  assert.strictEqual(challengeSessionRes.body.ok, true);
  assert.strictEqual(challengeSessionRes.body.authenticated, false);
  assert.strictEqual(challengeSessionRes.body.challenge.email, 'compat.challenge@example.com');
  assert.strictEqual(challengeSessionRes.body.challenge.status, 'pending');
});

test('reporter-auth challenge-session returns missing-session when no pending challenge exists', async () => {
  const res = await request(app)
    .get('/api/reporter-auth/challenge-session');

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'SESSION_EXPIRED');
});

test('reporter-auth compat request-code issues a pending challenge cookie for the OTP session window', async () => {
  reporterDoc.email = 'compat.cookie@example.com';
  reporterDoc.emailLower = 'compat.cookie@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.cookie@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_login_challenge=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('HttpOnly')));
});

test('reporter-auth compat verify-code returns clean session-expired error when pre-auth session is missing', async () => {
  reporterDoc.email = 'compat.expired@example.com';
  reporterDoc.emailLower = 'compat.expired@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.expired@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const verifyRes = await request(app)
    .post('/api/reporter-auth/verify-code')
    .send({ email: 'compat.expired@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 401);
  assert.strictEqual(verifyRes.body.code, 'SESSION_EXPIRED');
});

test('reporter-auth compat verify-code succeeds with the latest OTP and active challenge session', async () => {
  const agent = request.agent(app);
  reporterDoc.email = 'compat.success@example.com';
  reporterDoc.emailLower = 'compat.success@example.com';

  const otpRes = await agent
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.success@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);

  const verifyRes = await agent
    .post('/api/reporter-auth/verify-code')
    .send({ email: 'compat.success@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.strictEqual(verifyRes.body.reporter.email, 'compat.success@example.com');
});

test('reporter-auth compat challenge and verify flow works with only the persistent challenge cookie', async () => {
  reporterDoc.email = 'compat.cookieonly@example.com';
  reporterDoc.emailLower = 'compat.cookieonly@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.cookieonly@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));

  const challengeCookieHeader = otpRes.headers['set-cookie']
    .filter((value) => value.includes('reporter_portal_login_challenge='))
    .map((value) => value.split(';')[0])
    .join('; ');

  assert.ok(challengeCookieHeader.includes('reporter_portal_login_challenge='));

  const challengeSessionRes = await request(app)
    .get('/api/reporter-auth/challenge-session')
    .set('Cookie', challengeCookieHeader);

  assert.strictEqual(challengeSessionRes.statusCode, 200);
  assert.strictEqual(challengeSessionRes.body.ok, true);
  assert.strictEqual(challengeSessionRes.body.challenge.email, 'compat.cookieonly@example.com');
  assert.strictEqual(challengeSessionRes.body.challenge.status, 'pending');

  const verifyRes = await request(app)
    .post('/api/reporter-auth/verify-code')
    .set('Cookie', challengeCookieHeader)
    .send({ email: 'compat.cookieonly@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.strictEqual(verifyRes.body.reporter.email, 'compat.cookieonly@example.com');
});

test('reporter-auth compat request-code issues both pending challenge and session cookies for the OTP window', async () => {
  reporterDoc.email = 'compat.cookie@example.com';
  reporterDoc.emailLower = 'compat.cookie@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .send({ email: 'compat.cookie@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_login_challenge=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal.sid=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('HttpOnly')));
});

test('reporter-auth compat request-code sets secure shared-domain cookies on newspulse production hosts', async () => {
  reporterDoc.email = 'compat.prod@example.com';
  reporterDoc.emailLower = 'compat.prod@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .set('Host', 'api.newspulse.co.in')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('x-forwarded-proto', 'https')
    .send({ email: 'compat.prod@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_login_challenge=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal.sid=')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('SameSite=None')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('Secure')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('Domain=.newspulse.co.in')));

  const cookieHeader = otpRes.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');

  const sessionRes = await request(app)
    .get('/api/reporter-auth/session')
    .set('Host', 'api.newspulse.co.in')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('Cookie', cookieHeader)
    .set('x-forwarded-proto', 'https');

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.authenticated, false);
  assert.strictEqual(sessionRes.body.challenge.status, 'pending');
  assert.strictEqual(sessionRes.body.challenge.email, 'compat.prod@example.com');

  const challengeSessionRes = await request(app)
    .get('/api/reporter-auth/challenge-session')
    .set('Host', 'api.newspulse.co.in')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('Cookie', cookieHeader)
    .set('x-forwarded-proto', 'https');

  assert.strictEqual(challengeSessionRes.statusCode, 200);
  assert.strictEqual(challengeSessionRes.body.challenge.email, 'compat.prod@example.com');
  assert.strictEqual(challengeSessionRes.body.challenge.status, 'pending');
});

test('reporter-auth compat request-code infers secure shared-domain cookies from an HTTPS frontend origin', async () => {
  reporterDoc.email = 'compat.originhttps@example.com';
  reporterDoc.emailLower = 'compat.originhttps@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .set('Host', 'api.newspulse.co.in')
    .set('Origin', 'https://www.newspulse.co.in')
    .send({ email: 'compat.originhttps@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_login_challenge=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal.sid=')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('SameSite=None')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('Secure')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('Domain=.newspulse.co.in')));
});

test('reporter-auth compat request-code keeps cookies host-only on non-newspulse HTTPS hosts', async () => {
  reporterDoc.email = 'compat.render@example.com';
  reporterDoc.emailLower = 'compat.render@example.com';

  const otpRes = await request(app)
    .post('/api/reporter-auth/request-code')
    .set('Host', 'newspulse-backend.onrender.com')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('x-forwarded-proto', 'https')
    .send({ email: 'compat.render@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.ok(Array.isArray(otpRes.headers['set-cookie']));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal_login_challenge=')));
  assert.ok(otpRes.headers['set-cookie'].some((value) => value.includes('reporter_portal.sid=')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('SameSite=None')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => value.includes('Secure')));
  assert.ok(otpRes.headers['set-cookie'].every((value) => !value.includes('Domain=')));

  const cookieHeader = otpRes.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');

  const sessionRes = await request(app)
    .get('/api/reporter-auth/session')
    .set('Host', 'newspulse-backend.onrender.com')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('Cookie', cookieHeader)
    .set('x-forwarded-proto', 'https');

  assert.strictEqual(sessionRes.statusCode, 200);
  assert.strictEqual(sessionRes.body.authenticated, false);
  assert.strictEqual(sessionRes.body.challenge.status, 'pending');
  assert.strictEqual(sessionRes.body.challenge.email, 'compat.render@example.com');
});

test('reporter portal email change requires re-login after verification', async () => {
  process.env.REPORTER_OTP_RESEND_COOLDOWN_MS = '0';
  try {
    reporterDoc.email = 'emailchange@example.com';
    reporterDoc.emailLower = 'emailchange@example.com';

    const otpRes = await request(app)
      .post('/api/reporter-portal/auth/request-login-otp')
      .send({ email: 'emailchange@example.com' });
    const verifyRes = await request(app)
      .post('/api/reporter-portal/auth/verify-login-otp')
      .send({ email: 'emailchange@example.com', otp: otpRes.body.devCode });

    assert.strictEqual(verifyRes.statusCode, 200);
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

    assert.strictEqual(oldSessionRes.body.code, 'REPORTER_SESSION_MISSING');

    const newOtpRes = await request(app)
      .post('/api/reporter-portal/auth/request-login-otp')
      .send({ email: 'reporter.new@example.com' });

    assert.strictEqual(newOtpRes.statusCode, 200);
    const newVerifyRes = await request(app)
      .post('/api/reporter-portal/auth/verify-login-otp')
      .send({ email: 'reporter.new@example.com', otp: newOtpRes.body.devCode });

    assert.strictEqual(newVerifyRes.statusCode, 200);
    assert.strictEqual(newVerifyRes.body.reporter.email, 'reporter.new@example.com');
  } finally {
    process.env.REPORTER_OTP_RESEND_COOLDOWN_MS = '0';
  }
});

test('reporter portal login normalizes mixed-case email and still loads reporter submissions', async () => {
  reporterDoc.email = 'mixed@example.com';
  reporterDoc.emailLower = 'mixed@example.com';
  submissionStore = [
    {
      ...submissionStore[0],
      reporterId: reporterDoc._id,
      reporterEmail: 'mixed@example.com',
      reporterEmailNorm: 'mixed@example.com',
      email: 'mixed@example.com',
      submittedByEmail: 'mixed@example.com',
      contact: { email: 'mixed@example.com', name: 'Reporter One' },
    },
    {
      ...submissionStore[1],
      reporterId: reporterDoc._id,
      reporterEmail: 'mixed@example.com',
      reporterEmailNorm: 'mixed@example.com',
      email: 'mixed@example.com',
      contactEmail: 'mixed@example.com',
      contact: { email: 'mixed@example.com', name: 'Reporter One' },
    },
  ];

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: ' Mixed@Example.com ' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.strictEqual(otpRes.body.ok, true);

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: ' Mixed@Example.com ', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.reporter.email, 'mixed@example.com');

  const submissionsRes = await request(app)
    .get('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.total, 2);
  assert.strictEqual(submissionsRes.body.items.length, 2);
});

test('reporter portal submissions returns 200 with empty items for verified reporter with zero records', async () => {
  reporterDoc.email = 'empty@example.com';
  reporterDoc.emailLower = 'empty@example.com';
  submissionStore = [];

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'empty@example.com' });

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'empty@example.com', otp: otpRes.body.devCode });

  const submissionsRes = await request(app)
    .get('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.deepStrictEqual(submissionsRes.body.items, []);
  assert.strictEqual(submissionsRes.body.total, 0);
  assert.strictEqual(submissionsRes.body.meta.total, 0);
});

test('reporter portal submissions remain safe when reporter profile is missing after verification', async () => {
  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  reporterDoc = null;

  const submissionsRes = await request(app)
    .get('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.total, 2);
  assert.strictEqual(submissionsRes.body.items.length, 2);
});

test('reporter portal request-code returns stable unavailable code when transporter is not configured', async () => {
  const originalEmailMode = process.env.EMAIL_MODE;
  const originalRender = process.env.RENDER;

  reporterDoc.email = 'unavailable@example.com';
  reporterDoc.emailLower = 'unavailable@example.com';

  process.env.EMAIL_MODE = 'stub';
  process.env.RENDER = '1';

  try {
    const otpRes = await request(app)
      .post('/api/reporter-portal/auth/request-login-otp')
      .send({ email: 'unavailable@example.com' });

    assert.strictEqual(otpRes.statusCode, 503);
    assert.strictEqual(otpRes.body.code, 'REPORTER_EMAIL_UNAVAILABLE');
  } finally {
    if (originalEmailMode === undefined) delete process.env.EMAIL_MODE;
    else process.env.EMAIL_MODE = originalEmailMode;
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
  }
});

test('reporter portal request-code creates a reporter profile when email is valid but no prior profile exists', async () => {
  reporterDoc = null;
  submissionStore = [];

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'new.reporter@example.com' });

  assert.strictEqual(otpRes.statusCode, 200);
  assert.strictEqual(otpRes.body.ok, true);
  assert.ok(reporterDoc);
  assert.strictEqual(reporterDoc.email, 'new.reporter@example.com');

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'new.reporter@example.com', otp: otpRes.body.devCode });

  assert.strictEqual(verifyRes.statusCode, 200);
  assert.strictEqual(verifyRes.body.reporter.email, 'new.reporter@example.com');
});

test('reporter session endpoint returns stable missing-session code when auth is absent', async () => {
  const res = await request(app)
    .get('/api/reporter-auth/session');

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'SESSION_EXPIRED');
});

test('reporter portal counts linked articles as published outcomes and exposes them in published filters', async () => {
  submissionStore[1].status = 'APPROVED';
  submissionStore[1].linkedArticleId = '507f1f77bcf86cd7994390aa';
  submissionStore[1].articleId = '507f1f77bcf86cd7994390aa';

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  const dashboardRes = await request(app)
    .get('/api/reporter-portal/dashboard/summary')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(dashboardRes.statusCode, 200);
  assert.deepStrictEqual(dashboardRes.body.summary, {
    totalSubmissions: 2,
    pending: 1,
    approved: 0,
    rejected: 0,
    published: 1,
  });

  const publishedRes = await request(app)
    .get('/api/reporter-portal/submissions?status=published')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(publishedRes.statusCode, 200);
  assert.strictEqual(publishedRes.body.total, 1);
  assert.strictEqual(publishedRes.body.items[0].portalStatus, 'PUBLISHED');
});

test('reporter portal ownership lookup finds legacy mixed-case email records across fallback fields', async () => {
  submissionStore.push({
    _id: '507f1f77bcf86cd799439099',
    reporterId: '507f191e810c19729de860ff',
    reporterEmail: 'Reporter@Example.com',
    reporterEmailNorm: undefined,
    email: 'Reporter@Example.com',
    headline: 'Legacy Mixed Case',
    body: 'Legacy body',
    category: 'district',
    status: 'APPROVED',
    createdAt: new Date('2026-04-05T09:30:00.000Z'),
    updatedAt: new Date('2026-04-05T09:30:00.000Z'),
    isDeleted: false,
    contact: { email: 'Reporter@Example.com', name: 'Reporter One' },
    attachments: [],
  });

  const otpRes = await request(app)
    .post('/api/reporter-portal/auth/request-login-otp')
    .send({ email: 'reporter@example.com' });

  const verifyRes = await request(app)
    .post('/api/reporter-portal/auth/verify-login-otp')
    .send({ email: 'reporter@example.com', otp: otpRes.body.devCode });

  const submissionsRes = await request(app)
    .get('/api/reporter-portal/submissions')
    .set('Authorization', `Bearer ${verifyRes.body.token}`);

  assert.strictEqual(submissionsRes.statusCode, 200);
  assert.strictEqual(submissionsRes.body.total, 3);
  assert.ok(submissionsRes.body.items.some((item) => item.id === '507f1f77bcf86cd799439099'));
});