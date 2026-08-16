process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'push-notification-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const PushRegistration = require('../models/PushRegistration');
const PushDeliveryLog = require('../models/PushDeliveryLog');
const firebaseAdmin = require('../lib/firebaseAdmin');
const pushMessagingService = require('../services/pushMessagingService');
const pushRegistrationController = require('../controllers/pushRegistrationController');
const app = require('../server');

const MODEL_METHODS = ['findOneAndUpdate', 'deleteOne', 'findOne', 'find', 'updateOne', 'countDocuments'];
const modelOriginals = Object.fromEntries(MODEL_METHODS.map((name) => [name, PushRegistration[name]]));
const DELIVERY_LOG_METHODS = ['create', 'find', 'findOne', 'updateOne', 'countDocuments'];
const deliveryLogOriginals = Object.fromEntries(DELIVERY_LOG_METHODS.map((name) => [name, PushDeliveryLog[name]]));
const originalSendTestPushNotification = pushMessagingService.sendTestPushNotification;
const originalConsoleWarn = console.warn;
const envKeys = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'];
const envOriginals = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of Object.entries(envOriginals)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreStubs() {
  for (const [name, fn] of Object.entries(modelOriginals)) {
    PushRegistration[name] = fn;
  }
  for (const [name, fn] of Object.entries(deliveryLogOriginals)) {
    PushDeliveryLog[name] = fn;
  }
  pushMessagingService.sendTestPushNotification = originalSendTestPushNotification;
  if (typeof pushRegistrationController.__resetPushAntiSpamForTests === 'function') pushRegistrationController.__resetPushAntiSpamForTests();
  console.warn = originalConsoleWarn;
  restoreEnv();
  firebaseAdmin.resetFirebaseAdminForTests();
}

test.afterEach(restoreStubs);

function makeOpaqueAdminToken(email = 'kiran@newspulse.co.in') {
  return `np.${Buffer.from(`${email}:0`, 'utf8').toString('base64')}`;
}

function setPath(target, path, value) {
  const parts = String(path).split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPath(target, path) {
  return String(path).split('.').reduce((cursor, key) => (cursor && cursor[key] !== undefined ? cursor[key] : undefined), target);
}

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if (Object.prototype.hasOwnProperty.call(condition, '$ne')) {
      return condition.$ne === null ? value !== null && value !== undefined : value !== condition.$ne;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$gt')) {
      return Number(value || 0) > Number(condition.$gt || 0);
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$gte')) {
      return new Date(value || 0).getTime() >= new Date(condition.$gte || 0).getTime();
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$lte')) {
      return new Date(value || 0).getTime() <= new Date(condition.$lte || 0).getTime();
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$in')) {
      return Array.isArray(condition.$in) && condition.$in.includes(value);
    }
  }
  return value === condition;
}

function matchesFilter(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter || {})) {
    if (key === '$or') {
      if (!Array.isArray(condition) || !condition.some((item) => matchesFilter(doc, item))) return false;
      continue;
    }
    if (!matchesCondition(getPath(doc, key), condition)) return false;
  }
  return true;
}

function installInMemoryRegistrationStore() {
  const docs = new Map();
  let nextId = 1;

  function keyFor(filter) {
    return `${filter.registrationType}:${filter.registrationId}`;
  }

  function updatePaths(update) {
    const paths = [];
    for (const operator of ['$set', '$setOnInsert']) {
      for (const path of Object.keys(update[operator] || {})) paths.push({ operator, path });
    }
    return paths;
  }

  function pathConflicts(left, right) {
    return left.path === right.path || left.path.startsWith(`${right.path}.`) || right.path.startsWith(`${left.path}.`);
  }

  function assertNoUpdatePathConflicts(update) {
    const paths = updatePaths(update);
    for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
        if (pathConflicts(paths[leftIndex], paths[rightIndex])) {
          const error = new Error(`Updating the path '${paths[leftIndex].path}' would create a conflict at '${paths[rightIndex].path}'`);
          error.name = 'MongoServerError';
          error.code = 40;
          throw error;
        }
      }
    }
  }

  function applyUpdate(doc, update, { isInsert = false } = {}) {
    if (isInsert && update.$setOnInsert) {
      for (const [key, value] of Object.entries(update.$setOnInsert)) setPath(doc, key, clone(value));
    }
    if (update.$set) {
      for (const [key, value] of Object.entries(update.$set)) setPath(doc, key, clone(value));
    }
  }

  PushRegistration.findOneAndUpdate = async (filter, update, options = {}) => {
    assertNoUpdatePathConflicts(update);
    const key = keyFor(filter);
    let doc = docs.get(key);
    const isInsert = !doc;
    if (!doc && options.upsert) {
      doc = { _id: `push-${nextId += 1}`, registrationId: filter.registrationId, registrationType: filter.registrationType };
      docs.set(key, doc);
    }
    if (!doc) return null;
    applyUpdate(doc, update, { isInsert });
    return clone(doc);
  };

  PushRegistration.deleteOne = async (filter) => {
    const key = keyFor(filter);
    const existed = docs.delete(key);
    return { deletedCount: existed ? 1 : 0 };
  };

  PushRegistration.updateOne = async (filter, update) => {
    const doc = Array.from(docs.values()).find((item) => matchesFilter(item, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(doc, update);
    return { matchedCount: 1, modifiedCount: 1 };
  };

  PushRegistration.countDocuments = async (filter = {}) => Array.from(docs.values()).filter((doc) => matchesFilter(doc, filter)).length;

  function makeQuery(filter = {}, { one = false } = {}) {
    let sortSpec = null;
    const query = {
      sort(value) { sortSpec = value; return this; },
      select() { return this; },
      async lean() {
        const rows = Array.from(docs.values()).filter((doc) => matchesFilter(doc, filter));
        if (sortSpec) {
          const [field, direction] = Object.entries(sortSpec)[0] || [];
          rows.sort((left, right) => {
            const leftDate = new Date(getPath(left, field) || 0).getTime();
            const rightDate = new Date(getPath(right, field) || 0).getTime();
            return direction < 0 ? rightDate - leftDate : leftDate - rightDate;
          });
        }
        const cloned = rows.map(clone);
        return one ? (cloned[0] || null) : cloned;
      },
      then(resolve, reject) { return this.lean().then(resolve, reject); },
    };
    return query;
  }

  PushRegistration.findOne = (filter = {}) => {
    return makeQuery(filter, { one: true });
  };

  PushRegistration.find = (filter = {}) => makeQuery(filter);

  return { docs };
}

function installInMemoryDeliveryLogStore() {
  const logs = [];
  let nextId = 1;
  PushDeliveryLog.create = async (value) => {
    const doc = { _id: String(nextId++).padStart(24, '0'), ...clone(value) };
    logs.push(doc);
    return clone(doc);
  };
  PushDeliveryLog.updateOne = async (filter, update) => {
    const doc = logs.find((item) => matchesFilter(item, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$inc) {
      for (const [key, value] of Object.entries(update.$inc)) setPath(doc, key, Number(getPath(doc, key) || 0) + Number(value || 0));
    }
    if (update.$set) {
      for (const [key, value] of Object.entries(update.$set)) setPath(doc, key, clone(value));
    }
    return { matchedCount: 1, modifiedCount: 1 };
  };
  PushDeliveryLog.countDocuments = async (filter = {}) => logs.filter((doc) => matchesFilter(doc, filter)).length;
  function makeQuery(filter = {}, { one = false } = {}) {
    let sortSpec = null;
    let skipValue = 0;
    let limitValue = null;
    const query = {
      sort(value) { sortSpec = value; return this; },
      skip(value) { skipValue = Math.max(0, Number(value) || 0); return this; },
      limit(value) { limitValue = value; return this; },
      select() { return this; },
      async lean() {
        let rows = logs.filter((doc) => matchesFilter(doc, filter));
        if (sortSpec) {
          const entries = Object.entries(sortSpec);
          rows = rows.slice().sort((left, right) => {
            for (const [field, direction] of entries) {
              const leftValue = new Date(getPath(left, field) || 0).getTime();
              const rightValue = new Date(getPath(right, field) || 0).getTime();
              if (leftValue !== rightValue) return direction < 0 ? rightValue - leftValue : leftValue - rightValue;
            }
            return 0;
          });
        }
        if (skipValue) rows = rows.slice(skipValue);
        if (limitValue !== null) rows = rows.slice(0, limitValue);
        const cloned = rows.map(clone);
        return one ? (cloned[0] || null) : cloned;
      },
      then(resolve, reject) { return this.lean().then(resolve, reject); },
    };
    return query;
  }
  PushDeliveryLog.find = (filter = {}) => makeQuery(filter);
  PushDeliveryLog.findOne = (filter = {}) => makeQuery(filter, { one: true });
  return { logs };
}

function makeDeliveryLog(index, overrides = {}) {
  return {
    _id: String(index).padStart(24, '0'),
    type: index % 2 === 0 ? 'article' : 'breaking',
    title: `Push ${index}`,
    body: `Push body ${index}`,
    url: `https://www.newspulse.co.in/news/push-${index}`,
    articleId: null,
    articleSlug: null,
    category: index % 2 === 0 ? 'national' : null,
    language: 'en',
    targetedCount: 1,
    successCount: 1,
    failureCount: 0,
    browserReceivedCount: 0,
    notificationShownCount: 0,
    clickedCount: 0,
    displayFailedCount: 0,
    firstReceivedAt: null,
    lastReceivedAt: null,
    firstShownAt: null,
    lastShownAt: null,
    firstClickedAt: null,
    lastClickedAt: null,
    sentAt: new Date(Date.UTC(2026, 7, 13, index, 0, 0)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 7, 13, index, 1, 0)).toISOString(),
    fcmAcceptedAt: null,
    fcmLatencyMs: null,
    firstBrowserReceivedLatencyMs: null,
    firstNotificationShownLatencyMs: null,
    firstClickLatencyMs: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    lastDisplayFailureReason: null,
    ...overrides,
  };
}

function installFirebaseSendStub({ failCode, failMessage, failByToken, onSend } = {}) {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const sends = [];

  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: (options) => ({ options }),
    },
    messagingModule: {
      getMessaging: () => ({
        send: async (payload) => {
          sends.push(payload);
          if (typeof onSend === 'function') onSend(payload);
          const tokenFailure = failByToken && failByToken[payload.token];
          const failure = tokenFailure || (failCode ? { code: failCode, message: failMessage } : null);
          if (failure) {
            const error = new Error(failure.message || 'send failed');
            error.code = failure.code || 'messaging/internal-error';
            throw error;
          }
          return `message-${sends.length}`;
        },
      }),
    },
  });

  return { sends };
}

function assertNoPushSecrets(value, secrets = []) {
  const raw = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) assert.equal(raw.includes(secret), false);
  assert.equal(/BEGIN PRIVATE KEY|private_key|service_account/i.test(raw), false);
}

test('Firebase missing config returns safe not-configured status without throwing', () => {
  for (const key of envKeys) delete process.env[key];
  firebaseAdmin.resetFirebaseAdminForTests();

  const status = firebaseAdmin.getFirebaseAdminStatus();

  assert.equal(status.configured, false);
  assert.equal(status.messagingAvailable, false);
  assert.equal(status.status, 'not_configured');
  assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
});

test('Firebase Admin initializes only once', () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
  let initCount = 0;

  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [],
      cert: (value) => ({ type: 'cert', value }),
      applicationDefault: () => ({ type: 'adc' }),
      initializeApp: (options) => {
        initCount += 1;
        return { options };
      },
    },
    messagingModule: { getMessaging: () => ({ send: async () => 'ok' }) },
  });

  const first = firebaseAdmin.getFirebaseAdminStatus();
  const second = firebaseAdmin.getFirebaseAdminStatus();

  assert.equal(first.configured, true);
  assert.equal(second.configured, true);
  assert.equal(initCount, 1);
});

test('PushRegistration schema stores push preference shape and FCM token field', () => {
  const registration = new PushRegistration({
    registrationId: 'fcm-token-schema:defghijklmnopqrstuvwxyz0123456789',
    registrationType: 'token',
  });

  assert.equal(registration.enabled, true);
  assert.equal(registration.status, 'active');
  assert.equal(registration.registrationId, 'fcm-token-schema:defghijklmnopqrstuvwxyz0123456789');
  assert.equal(registration.registrationType, 'token');
  assert.equal(registration.preferences.breakingNews, true);
  assert.equal(registration.preferences.topStories, true);
  assert.equal(registration.preferences.newArticleAlerts, true);
  assert.equal(registration.preferences.categoryAlerts, true);
  assert.equal(registration.preferences.allArticles, false);
  assert.equal(PushRegistration.schema.path('registrationId').options.select, false);
});

test('PushDeliveryLog schema stores safe delivery timing fields only', () => {
  assert.ok(PushDeliveryLog.schema.path('sentAt'));
  assert.ok(PushDeliveryLog.schema.path('completedAt'));
  assert.ok(PushDeliveryLog.schema.path('fcmAcceptedAt'));
  assert.ok(PushDeliveryLog.schema.path('firstReceivedAt'));
  assert.ok(PushDeliveryLog.schema.path('lastReceivedAt'));
  assert.ok(PushDeliveryLog.schema.path('notificationShownCount'));
  assert.ok(PushDeliveryLog.schema.path('displayFailedCount'));
  assert.ok(PushDeliveryLog.schema.path('firstShownAt'));
  assert.ok(PushDeliveryLog.schema.path('lastShownAt'));
  assert.ok(PushDeliveryLog.schema.path('firstClickedAt'));
  assert.ok(PushDeliveryLog.schema.path('lastClickedAt'));
  assert.ok(PushDeliveryLog.schema.path('fcmLatencyMs'));
  assert.ok(PushDeliveryLog.schema.path('firstBrowserReceivedLatencyMs'));
  assert.ok(PushDeliveryLog.schema.path('firstNotificationShownLatencyMs'));
  assert.ok(PushDeliveryLog.schema.path('firstClickLatencyMs'));
  assert.ok(PushDeliveryLog.schema.path('lastDisplayFailureReason'));
  assert.equal(PushDeliveryLog.schema.path('registrationId'), undefined);
  assert.equal(PushDeliveryLog.schema.path('registrationToken'), undefined);
  assert.equal(PushDeliveryLog.schema.path('fcmToken'), undefined);
  assert.equal(PushDeliveryLog.schema.path('fid'), undefined);
  assert.equal(PushDeliveryLog.schema.path('firebaseInstallationId'), undefined);
});

test('POST /api/public/push/register validates registration ID', async () => {
  const response = await request(app)
    .post('/api/public/push/register')
    .send({ registrationId: '', registrationType: 'token' });

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
});

test('push registration upserts idempotently and preserves existing preferences', async () => {
  const token = 'fcm-token-abc:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  const first = await request(app)
    .post('/api/public/push/register')
    .send({
      token,
      platform: 'browser',
      language: 'hi',
      preferences: { breakingNews: false, allArticles: true },
      categories: ['technology'],
    });

  assert.equal(first.status, 200);
  assert.equal(first.body.registered, true);
  assert.equal(first.body.synced, true);
  assert.equal(first.body.registrationType, 'token');
  assert.equal(typeof first.body.fcmConfigured, 'boolean');
  assert.equal(typeof first.body.deliveryReady, 'boolean');
  assert.equal(JSON.stringify(first.body).includes(token), false);

  const second = await request(app)
    .post('/api/public/push/register')
    .send({ token, platform: 'web' });

  assert.equal(second.status, 200);
  assert.equal(docs.size, 1);
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.enabled, true);
  assert.equal(stored.status, 'active');
  assert.equal(stored.preferences.breakingNews, false);
  assert.equal(stored.preferences.newArticleAlerts, true);
  assert.equal(stored.preferences.categoryAlerts, true);
  assert.equal(stored.preferences.allArticles, true);
  assert.equal(stored.preferences.topStories, true);
  assert.equal(stored.language, 'hi');
  assert.deepEqual(stored.categories, ['technology']);
});

test('POST /api/public/push/register accepts fid payload as non-deliverable', async () => {
  const { docs } = installInMemoryRegistrationStore();

  const response = await request(app)
    .post('/api/public/push/register')
    .send({
      registrationId: 'debug-test-registration-id-delete-me-123456',
      registrationType: 'fid',
      platform: 'web',
      language: 'en',
      preferences: {
        breakingNews: true,
        topStories: true,
        newArticleAlerts: true,
        categoryAlerts: true,
        allArticles: false,
      },
      categories: [],
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.registered, false);
  assert.equal(response.body.synced, true);
  assert.equal(response.body.reason, 'missing_fcm_token');
  assert.equal(response.body.registrationType, 'fid');
  assert.equal(typeof response.body.fcmConfigured, 'boolean');
  assert.equal(response.body.deliveryReady, false);
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.registrationType, 'fid');
  assert.equal(stored.enabled, true);
  assert.equal(stored.status, 'active');
  assert.equal(stored.preferences.newArticleAlerts, true);
  assert.equal(JSON.stringify(response.body).includes('debug-test-registration-id-delete-me-123456'), false);
});

test('POST /api/public/push/register stores token when token and fid are both present', async () => {
  const token = 'fcm-token-with-fid:defghijklmnopqrstuvwxyz0123456789';
  const fid = 'firebase-installation-token-paired';
  const { docs } = installInMemoryRegistrationStore();

  const response = await request(app)
    .post('/api/public/push/register')
    .send({ registrationId: fid, registrationType: 'fid', token, preferences: { newArticleAlerts: true } });

  assert.equal(response.status, 200);
  assert.equal(response.body.registered, true);
  assert.equal(response.body.registrationType, 'token');
  assert.equal(docs.size, 1);
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.registrationId, token);
  assert.equal(stored.registrationType, 'token');
  assert.equal(stored.enabled, true);
  assert.equal(stored.status, 'active');
  assert.equal(stored.preferences.newArticleAlerts, true);
  assertNoPushSecrets(response.body, [token, fid]);
});

test('token registration with breakingNews=true increments breaking subscribers safely', async () => {
  const token = 'fcm-token-breaking-register:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  const register = await request(app)
    .post('/api/public/push/register')
    .send({ token, preferences: { breakingNews: true, newArticleAlerts: false } });

  assert.equal(register.status, 200);
  assert.equal(register.body.registrationType, 'token');
  assert.equal(docs.size, 1);
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.registrationType, 'token');
  assert.equal(stored.enabled, true);
  assert.equal(stored.status, 'active');
  assert.equal(stored.preferences.breakingNews, true);
  assert.equal(stored.preferences.newArticleAlerts, false);

  const diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.body.enabledFcmTokenRegistrations, 1);
  assert.equal(diagnostics.body.deliverablePushDevices, 1);
  assert.equal(diagnostics.body.breakingNewsSubscribers, 1);
  assert.equal(diagnostics.body.articleAlertSubscribers, 0);
  assertNoPushSecrets(register.body, [token]);
  assertNoPushSecrets(diagnostics.body, [token]);
});

test('GET /api/public/push/diagnostics returns safe missing-Firebase diagnostics with empty Mongo data', async () => {
  for (const key of envKeys) delete process.env[key];
  firebaseAdmin.resetFirebaseAdminForTests();
  installInMemoryRegistrationStore();

  const response = await request(app).get('/api/public/push/diagnostics');

  assert.equal(response.status, 200);
  assert.equal(response.body.firebaseConfigured, false);
  assert.equal(response.body.messagingAvailable, false);
  assert.equal(response.body.firebaseStatus, 'not_configured');
  assert.equal(response.body.pushRegistrationModelAvailable, true);
  assert.equal(response.body.totalRegistrations, 0);
  assert.equal(response.body.enabledRegistrations, 0);
  assert.equal(response.body.disabledRegistrations, 0);
  assert.equal(response.body.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.breakingNewsSubscribers, 0);
  assert.equal(response.body.articleAlertSubscribers, 0);
  assert.equal(response.body.topStoriesSubscribers, 0);
  assert.equal(response.body.categoryAlertSubscribers, 0);
  assert.equal(response.body.allArticlesSubscribers, 0);
  assert.equal(response.body.lastRegistrationAt, null);
  assert.equal(response.body.registrationStats.totalRegistrations, 0);
  assert.equal(response.body.registrationStats.enabledRegistrations, 0);
  assert.equal(response.body.registrationStats.disabledRegistrations, 0);
  assert.equal(response.body.registrationStats.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.registrationStats.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.registrationStats.breakingNewsSubscribers, 0);
  assert.equal(response.body.registrationStats.articleAlertSubscribers, 0);
  assert.equal(response.body.registrations.total, 0);
  assert.equal(response.body.registrations.enabled, 0);
  assert.equal(response.body.registrations.disabled, 0);
  assert.equal(response.body.registrations.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.registrations.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.registrations.breakingNewsSubscribers, 0);
  assert.equal(response.body.registrations.articleAlertSubscribers, 0);
  assert.equal(response.body.mongo.registrations.total, 0);
  assert.equal(response.body.mongo.registrations.breakingNewsSubscribers, 0);
  assert.equal(response.body.mongo.registrations.articleAlertSubscribers, 0);
  assert.equal(response.body.deliveryReady, false);
  assert.deepEqual(response.body.supportedRegistrationTypes, ['fid', 'token']);
  assert.equal(Array.isArray(response.body.warnings), true);
  assertNoPushSecrets(response.body);
});

test('GET /api/public/push/diagnostics returns safe configured-Firebase registration health', async () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const token = 'fcm-token-diag:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: (options) => ({ options }),
    },
    messagingModule: { getMessaging: () => ({ send: async () => 'ok' }) },
  });

  const register = await request(app).post('/api/public/push/register').send({ token });
  assert.equal(register.status, 200);

  const stored = Array.from(docs.values())[0];
  stored.lastRegisteredAt = '2026-08-12T10:00:00.000Z';
  stored.lastSuccessfulSendAt = '2026-08-12T10:05:00.000Z';
  stored.lastFailureAt = '2026-08-12T10:10:00.000Z';
  stored.lastFailureCode = 'messaging/internal-error';
  stored.lastFailureReason = `Temporary Firebase outage for ${token}`;

  const response = await request(app).get('/api/public/push/diagnostics');

  assert.equal(response.status, 200);
  assert.equal(response.body.firebaseConfigured, true);
  assert.equal(response.body.messagingAvailable, true);
  assert.equal(response.body.firebaseStatus, 'configured');
  assert.equal(response.body.totalRegistrations, 1);
  assert.equal(response.body.enabledRegistrations, 1);
  assert.equal(response.body.disabledRegistrations, 0);
  assert.equal(response.body.enabledFcmTokenRegistrations, 1);
  assert.equal(response.body.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.breakingNewsSubscribers, 1);
  assert.equal(response.body.articleAlertSubscribers, 1);
  assert.equal(response.body.topStoriesSubscribers, 1);
  assert.equal(response.body.categoryAlertSubscribers, 1);
  assert.equal(response.body.allArticlesSubscribers, 0);
  assert.equal(response.body.registrationStats.totalRegistrations, 1);
  assert.equal(response.body.registrationStats.enabledRegistrations, 1);
  assert.equal(response.body.registrationStats.disabledRegistrations, 0);
  assert.equal(response.body.registrationStats.enabledFcmTokenRegistrations, 1);
  assert.equal(response.body.registrationStats.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.registrationStats.breakingNewsSubscribers, 1);
  assert.equal(response.body.registrationStats.articleAlertSubscribers, 1);
  assert.equal(response.body.registrationStats.topStoriesSubscribers, 1);
  assert.equal(response.body.registrationStats.categoryAlertSubscribers, 1);
  assert.equal(response.body.registrationStats.allArticlesSubscribers, 0);
  assert.equal(response.body.registrations.total, 1);
  assert.equal(response.body.registrations.enabled, 1);
  assert.equal(response.body.registrations.disabled, 0);
  assert.equal(response.body.registrations.enabledFcmTokenRegistrations, 1);
  assert.equal(response.body.registrations.enabledFidOnlyRegistrations, 0);
  assert.equal(response.body.registrations.breakingNewsSubscribers, 1);
  assert.equal(response.body.registrations.articleAlertSubscribers, 1);
  assert.equal(response.body.registrations.topStoriesSubscribers, 1);
  assert.equal(response.body.registrations.categoryAlertSubscribers, 1);
  assert.equal(response.body.registrations.allArticlesSubscribers, 0);
  assert.equal(response.body.mongo.registrations.total, 1);
  assert.equal(response.body.mongo.registrations.breakingNewsSubscribers, 1);
  assert.equal(response.body.mongo.registrations.articleAlertSubscribers, 1);
  assert.equal(response.body.lastRegistrationAt, '2026-08-12T10:00:00.000Z');
  assert.equal(response.body.lastSuccessfulSendAt, '2026-08-12T10:05:00.000Z');
  assert.equal(response.body.lastFailureAt, '2026-08-12T10:10:00.000Z');
  assert.equal(response.body.lastFailureCode, 'messaging/internal-error');
  assert.equal(response.body.lastFailureMessage, 'Temporary Firebase outage for [redacted-registration-id]');
  assert.equal(response.body.registrationStats.lastFailureMessage, 'Temporary Firebase outage for [redacted-registration-id]');
  assert.equal(response.body.mongo.lastFailureMessage, 'Temporary Firebase outage for [redacted-registration-id]');
  assert.equal(typeof response.body.mongoConnected, 'boolean');
  assert.equal(response.body.deliveryReady, true);
  assertNoPushSecrets(response.body, [token, process.env.FIREBASE_CLIENT_EMAIL, process.env.FIREBASE_PRIVATE_KEY]);
});

test('GET /api/public/push/diagnostics reports fid-only records as non-deliverable', async () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  const fid = 'firebase-installation-diagnostics-only';
  installInMemoryRegistrationStore();
  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: (options) => ({ options }),
    },
    messagingModule: { getMessaging: () => ({ send: async () => 'ok' }) },
  });

  const register = await request(app).post('/api/public/push/register').send({ registrationId: fid, registrationType: 'fid' });
  assert.equal(register.status, 200);
  assert.equal(register.body.registered, false);
  assert.equal(register.body.reason, 'missing_fcm_token');
  assert.equal(register.body.deliveryReady, false);

  const response = await request(app).get('/api/public/push/diagnostics');

  assert.equal(response.status, 200);
  assert.equal(response.body.totalRegistrations, 1);
  assert.equal(response.body.enabledRegistrations, 1);
  assert.equal(response.body.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.enabledFidOnlyRegistrations, 1);
  assert.equal(response.body.breakingNewsSubscribers, 0);
  assert.equal(response.body.articleAlertSubscribers, 0);
  assert.equal(response.body.registrationStats.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.registrationStats.enabledFidOnlyRegistrations, 1);
  assert.equal(response.body.registrationStats.breakingNewsSubscribers, 0);
  assert.equal(response.body.registrationStats.articleAlertSubscribers, 0);
  assert.equal(response.body.registrations.enabledFcmTokenRegistrations, 0);
  assert.equal(response.body.registrations.enabledFidOnlyRegistrations, 1);
  assert.equal(response.body.registrations.breakingNewsSubscribers, 0);
  assert.equal(response.body.registrations.articleAlertSubscribers, 0);
  assert.equal(response.body.deliveryReady, false);
  assert.equal(response.body.warnings.includes('no_enabled_fcm_token_registrations'), true);
  assertNoPushSecrets(response.body, [fid, process.env.FIREBASE_CLIENT_EMAIL, process.env.FIREBASE_PRIVATE_KEY]);
});

test('GET /api/public/push/diagnostics counts disabled registrations safely', async () => {
  const token = 'fcm-token-disabled-diag:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  await request(app).post('/api/public/push/register').send({ token });
  const stored = Array.from(docs.values())[0];
  stored.enabled = false;
  stored.status = 'inactive';
  stored.disabledAt = '2026-08-12T11:00:00.000Z';

  const response = await request(app).get('/api/public/push/diagnostics');

  assert.equal(response.status, 200);
  assert.equal(response.body.totalRegistrations, 1);
  assert.equal(response.body.enabledRegistrations, 0);
  assert.equal(response.body.disabledRegistrations, 1);
  assert.equal(response.body.registrationStats.disabledRegistrations, 1);
  assert.equal(response.body.registrations.disabled, 1);
  assert.equal(response.body.mongo.registrations.disabled, 1);
  assertNoPushSecrets(response.body, [token]);
});

test('GET /api/public/push/diagnostics does not crash when Mongo stats are unavailable', async () => {
  PushRegistration.countDocuments = async () => {
    const error = new Error('server selection failed');
    error.name = 'MongoServerSelectionError';
    throw error;
  };
  PushRegistration.findOne = () => ({
    sort() { return this; },
    select() { return this; },
    async lean() {
      const error = new Error('server selection failed');
      error.name = 'MongoServerSelectionError';
      throw error;
    },
  });

  const response = await request(app).get('/api/public/push/diagnostics');

  assert.equal(response.status, 200);
  assert.equal(response.body.totalRegistrations, 0);
  assert.equal(response.body.enabledRegistrations, 0);
  assert.equal(response.body.disabledRegistrations, 0);
  assert.equal(response.body.lastRegistrationAt, null);
  assert.equal(response.body.deliveryReady, false);
  assert.equal(response.body.warnings.includes('registration_count_unavailable'), true);
  assertNoPushSecrets(response.body);
});

test('GET /api/admin/push/diagnostics allows admin/founder auth and returns no identifiers', async () => {
  const token = 'fcm-token-admin-diag:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  await request(app).post('/api/public/push/register').send({ token });

  const response = await request(app)
    .get('/api/admin/push/diagnostics')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.totalRegistrations, 1);
  assertNoPushSecrets(response.body, [token]);
});

test('GET /api/admin/push/status includes safe Mongo registration stats for legacy callers', async () => {
  const token = 'fcm-token-status-diag:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();
  await request(app).post('/api/public/push/register').send({ token });
  const stored = Array.from(docs.values())[0];
  stored.lastFailureAt = '2026-08-12T12:00:00.000Z';
  stored.lastFailureCode = 'messaging/mismatched-credential';
  stored.lastFailureReason = `Sender ID mismatch for ${token}`;

  const response = await request(app)
    .get('/api/admin/push/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.firebase && typeof response.body.firebase.configured, 'boolean');
  assert.equal(response.body.totalRegistrations, 1);
  assert.equal(response.body.enabledRegistrations, 1);
  assert.equal(response.body.disabledRegistrations, 0);
  assert.equal(response.body.diagnostics.totalRegistrations, 1);
  assert.equal(response.body.registrationStats.totalRegistrations, 1);
  assert.equal(response.body.registrations.total, 1);
  assert.equal(response.body.mongo.registrations.total, 1);
  assert.equal(response.body.lastFailureCode, 'messaging/mismatched-credential');
  assert.equal(response.body.lastFailureMessage, 'Sender ID mismatch for [redacted-registration-id]');
  assert.equal(response.body.diagnostics.lastFailureCode, 'messaging/mismatched-credential');
  assert.equal(response.body.diagnostics.lastFailureMessage, 'Sender ID mismatch for [redacted-registration-id]');
  assertNoPushSecrets(response.body, [token]);
});

test('PUT /api/public/push/preferences updates only allow-listed fields', async () => {
  const token = 'fcm-token-pref:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  await request(app).post('/api/public/push/register').send({ token });

  const response = await request(app)
    .put('/api/public/push/preferences')
    .send({
      token,
      enabled: false,
      language: 'gu',
      preferences: { topStories: false },
      categories: ['sports'],
      arbitraryMongoField: { $ne: true },
    });

  assert.equal(response.status, 400);

  const valid = await request(app)
    .put('/api/public/push/preferences')
    .send({
      token,
      enabled: false,
      language: 'gu',
      preferences: { topStories: false },
      categories: ['sports'],
    });

  assert.equal(valid.status, 200);
  assert.equal(valid.body.preferencesSaved, true);
  assert.equal(valid.body.synced, true);
  assert.equal(valid.body.registrationType, 'token');
  assert.equal(typeof valid.body.fcmConfigured, 'boolean');
  assert.equal(typeof valid.body.deliveryReady, 'boolean');
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.enabled, false);
  assert.equal(stored.status, 'inactive');
  assert.equal(stored.language, 'gu');
  assert.equal(stored.preferences.topStories, false);
  assert.equal(stored.preferences.breakingNews, true);
  assert.deepEqual(stored.categories, ['sports']);
});

test('PUT /api/public/push/preferences updates token breakingNews without duplicates or preference loss', async () => {
  const token = 'fcm-token-pref-breaking:defghijklmnopqrstuvwxyz0123456789';
  const fid = 'firebase-installation-pref-breaking';
  const { docs } = installInMemoryRegistrationStore();

  await request(app).post('/api/public/push/register').send({ registrationId: fid, registrationType: 'fid', preferences: { breakingNews: true } });
  await request(app).post('/api/public/push/register').send({ token, preferences: { breakingNews: false, newArticleAlerts: true, topStories: false } });

  const enable = await request(app)
    .put('/api/public/push/preferences')
    .send({ registrationId: fid, registrationType: 'fid', token, preferences: { breakingNews: true } });

  assert.equal(enable.status, 200);
  assert.equal(enable.body.registrationType, 'token');
  assert.equal(docs.size, 2);
  const tokenRecord = Array.from(docs.values()).find((item) => item.registrationId === token);
  const fidRecord = Array.from(docs.values()).find((item) => item.registrationId === fid);
  assert.equal(tokenRecord.registrationType, 'token');
  assert.equal(tokenRecord.enabled, true);
  assert.equal(tokenRecord.status, 'active');
  assert.equal(tokenRecord.preferences.breakingNews, true);
  assert.equal(tokenRecord.preferences.newArticleAlerts, true);
  assert.equal(tokenRecord.preferences.topStories, false);
  assert.equal(fidRecord.preferences.breakingNews, true);

  let diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.body.breakingNewsSubscribers, 1);
  assert.equal(diagnostics.body.articleAlertSubscribers, 1);
  assert.equal(diagnostics.body.enabledFidOnlyRegistrations, 1);

  const disable = await request(app)
    .put('/api/public/push/preferences')
    .send({ token, preferences: { breakingNews: false } });

  assert.equal(disable.status, 200);
  assert.equal(docs.size, 2);
  assert.equal(tokenRecord.preferences.breakingNews, false);
  assert.equal(tokenRecord.preferences.newArticleAlerts, true);
  diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.body.breakingNewsSubscribers, 0);
  assert.equal(diagnostics.body.articleAlertSubscribers, 1);
  assertNoPushSecrets(enable.body, [token, fid]);
  assertNoPushSecrets(disable.body, [token, fid]);
  assertNoPushSecrets(diagnostics.body, [token, fid]);
});

test('push registration rejects invalid language and invalid categories', async () => {
  installInMemoryRegistrationStore();

  const invalidLanguage = await request(app)
    .post('/api/public/push/register')
    .send({ token: 'fcm-token-lang:defghijklmnopqrstuvwxyz0123456789', language: 'fr' });

  assert.equal(invalidLanguage.status, 400);

  const invalidCategory = await request(app)
    .post('/api/public/push/register')
    .send({ token: 'fcm-token-cat:defghijklmnopqrstuvwxyz0123456789', categories: ['not-a-category'] });

  assert.equal(invalidCategory.status, 400);
});

test('DELETE /api/public/push/unregister disables only requested registration and keeps it for diagnostics', async () => {
  const firstToken = 'fcm-token-one:defghijklmnopqrstuvwxyz0123456789';
  const secondToken = 'fcm-token-two:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();

  await request(app).post('/api/public/push/register').send({ token: firstToken });
  await request(app).post('/api/public/push/register').send({ token: secondToken });

  const response = await request(app)
    .delete('/api/public/push/unregister')
    .send({ token: firstToken });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.success, true);
  assert.equal(response.body.unregistered, true);
  assert.equal(response.body.synced, true);
  assert.equal(response.body.registrationType, 'token');
  assert.equal(typeof response.body.fcmConfigured, 'boolean');
  assert.equal(typeof response.body.deliveryReady, 'boolean');
  assert.equal(response.body.disabled, true);
  assert.equal(docs.size, 2);
  const disabled = Array.from(docs.values()).find((item) => item.registrationId === firstToken);
  const active = Array.from(docs.values()).find((item) => item.registrationId === secondToken);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'inactive');
  assert.equal(Boolean(disabled.disabledAt), true);
  assert.equal(Boolean(disabled.updatedAt), true);
  assert.equal(active.enabled, true);
  assert.equal(active.status, 'active');

  const diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.body.totalRegistrations, 2);
  assert.equal(diagnostics.body.enabledRegistrations, 1);
  assert.equal(diagnostics.body.disabledRegistrations, 1);
  assert.equal(diagnostics.body.registrationStats.disabledRegistrations, 1);
  assert.equal(diagnostics.body.registrations.disabled, 1);
  const status = await request(app)
    .get('/api/admin/push/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.totalRegistrations, 2);
  assert.equal(status.body.enabledRegistrations, 1);
  assert.equal(status.body.disabledRegistrations, 1);
  assert.equal(status.body.diagnostics.disabledRegistrations, 1);
  assertNoPushSecrets(response.body, [firstToken, secondToken]);
  assertNoPushSecrets(diagnostics.body, [firstToken, secondToken]);
  assertNoPushSecrets(status.body, [firstToken, secondToken]);
});

test('POST /api/public/push/unregister disables fid-only registrations without deleting them', async () => {
  const fid = 'firebase-installation-disable-only';
  const { docs } = installInMemoryRegistrationStore();

  await request(app).post('/api/public/push/register').send({ registrationId: fid, registrationType: 'fid' });

  const response = await request(app)
    .post('/api/public/push/unregister')
    .send({ registrationId: fid, registrationType: 'fid' });

  assert.equal(response.status, 200);
  assert.equal(response.body.unregistered, true);
  assert.equal(response.body.disabled, true);
  assert.equal(response.body.registrationType, 'fid');
  assert.equal(docs.size, 1);
  const stored = Array.from(docs.values())[0];
  assert.equal(stored.registrationId, fid);
  assert.equal(stored.registrationType, 'fid');
  assert.equal(stored.enabled, false);
  assert.equal(stored.status, 'inactive');
  assert.equal(Boolean(stored.disabledAt), true);

  const diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.body.totalRegistrations, 1);
  assert.equal(diagnostics.body.enabledRegistrations, 0);
  assert.equal(diagnostics.body.disabledRegistrations, 1);
  assert.equal(diagnostics.body.enabledFidOnlyRegistrations, 0);
  assertNoPushSecrets(response.body, [fid]);
  assertNoPushSecrets(diagnostics.body, [fid]);
});

test('public caller cannot access Founder-only push test route', async () => {
  const response = await request(app)
    .post('/api/admin/push/test')
    .send({ title: 'News Pulse' });

  assert.equal(response.status, 401);
});

test('admin role cannot access Founder-only push test route', async () => {
  const response = await request(app)
    .post('/api/admin/push/test')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ title: 'News Pulse' });

  assert.equal(response.status, 403);
});

test('Founder can invoke one-device push test route without leaking registration ID', async () => {
  const token = 'fcm-token-route:defghijklmnopqrstuvwxyz0123456789';
  pushMessagingService.sendTestPushNotification = async (input) => {
    assert.equal(input.registrationId, token);
    return { success: true, sent: true, messageId: 'projects/test/messages/1' };
  };

  const response = await request(app)
    .post('/api/admin/push/test')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ registrationId: token, registrationType: 'token' });

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, true);
  assert.equal(JSON.stringify(response.body).includes(token), false);
});

test('POST /api/admin/push/test-latest sends to one latest enabled device only', async () => {
  const firstToken = 'fcm-token-test-old:defghijklmnopqrstuvwxyz0123456789';
  const secondToken = 'fcm-token-test-new:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({ token: firstToken });
  await request(app).post('/api/public/push/register').send({ token: secondToken });
  const stored = Array.from(docs.values());
  stored.find((item) => item.registrationId === firstToken).lastRegisteredAt = '2026-08-12T10:00:00.000Z';
  stored.find((item) => item.registrationId === secondToken).lastRegisteredAt = '2026-08-12T11:00:00.000Z';

  const response = await request(app)
    .post('/api/admin/push/test-latest')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, true);
  assert.equal(response.body.targetedCount, 1);
  assert.equal(response.body.successCount, 1);
  assert.equal(response.body.deliveryLogCreated, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].token, secondToken);
  assert.equal(logs.length, 0);
  assert.equal(Boolean(stored.find((item) => item.registrationId === secondToken).lastSuccessfulSendAt), true);
  assert.equal(Boolean(stored.find((item) => item.registrationId === firstToken).lastSuccessfulSendAt), false);
  assertNoPushSecrets(response.body, [firstToken, secondToken, process.env.FIREBASE_PRIVATE_KEY]);
  assertNoPushSecrets(logs, [firstToken, secondToken, process.env.FIREBASE_PRIVATE_KEY]);
});

test('POST /api/admin/push/breaking requires confirmSend', async () => {
  const { sends } = installFirebaseSendStub();
  const { logs } = installInMemoryDeliveryLogStore();
  installInMemoryRegistrationStore();

  const response = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ title: 'Breaking News', body: 'Breaking news message', url: 'https://www.newspulse.co.in/news/breaking', language: 'en' });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'CONFIRM_SEND_REQUIRED');
  assert.equal(sends.length, 0);
  assert.equal(logs.length, 0);
});

test('POST /api/admin/push/article requires confirmSend', async () => {
  const { sends } = installFirebaseSendStub();
  const { logs } = installInMemoryDeliveryLogStore();
  installInMemoryRegistrationStore();

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ title: 'Article title', body: 'Article summary', url: 'https://www.newspulse.co.in/news/article-slug', language: 'en' });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'CONFIRM_SEND_REQUIRED');
  assert.equal(sends.length, 0);
  assert.equal(logs.length, 0);
});

test('POST /api/admin/push/breaking does not target disabled devices and creates delivery log', async () => {
  const activeToken = 'fcm-token-breaking-active:defghijklmnopqrstuvwxyz0123456789';
  const otherLanguageToken = 'fcm-token-breaking-other-language:defghijklmnopqrstuvwxyz0123456789';
  const preferenceOffToken = 'fcm-token-breaking-pref-off:defghijklmnopqrstuvwxyz0123456789';
  const disabledToken = 'fcm-token-breaking-disabled:defghijklmnopqrstuvwxyz0123456789';
  const activeFid = 'firebase-installation-breaking-active';
  const { docs } = installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const sendObservations = [];
  const { sends } = installFirebaseSendStub({
    onSend: (payload) => {
      sendObservations.push({
        deliveryLogId: payload.data.deliveryLogId,
        deliveryLogExistsBeforeSend: logs.some((item) => String(item._id) === payload.data.deliveryLogId),
      });
    },
  });

  await request(app).post('/api/public/push/register').send({ token: activeToken });
  await request(app).post('/api/public/push/register').send({ token: otherLanguageToken, language: 'gu', preferences: { breakingNews: true } });
  await request(app).post('/api/public/push/register').send({ token: preferenceOffToken, preferences: { breakingNews: false } });
  await request(app).post('/api/public/push/register').send({ token: disabledToken });
  await request(app).post('/api/public/push/register').send({ registrationId: activeFid, registrationType: 'fid', preferences: { breakingNews: true } });
  const unregister = await request(app).delete('/api/public/push/unregister').send({ token: disabledToken });
  assert.equal(unregister.status, 200);
  assert.equal(unregister.body.disabled, true);

  const response = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      title: 'Breaking News',
      body: 'Breaking news message',
      url: 'https://www.newspulse.co.in/news/breaking',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'sent');
  assert.equal(response.body.deliveryProofStatus, 'fcm_accepted');
  assert.equal(response.body.reason, null);
  assert.equal(response.body.targetedCount, 2);
  assert.equal(response.body.successCount, 2);
  assert.equal(response.body.failureCount, 0);
  assert.equal(response.body.targetingDebug.enabledDevices, 3);
  assert.equal(response.body.targetingDebug.deliverablePushDevices, 3);
  assert.equal(response.body.targetingDebug.breakingNewsSubscribers, 2);
  assert.equal(response.body.targetingDebug.excludedPreferenceOffCount, 1);
  assert.equal(response.body.targetingDebug.excludedDisabledCount, 1);
  assert.equal(response.body.targetingDebug.excludedFidOnlyCount, 1);
  assert.equal(response.body.targetingDebug.targetedCount, 2);
  assert.equal(typeof response.body.fcmAcceptedAt, 'string');
  assert.equal(typeof response.body.fcmLatencyMs, 'number');
  assert.equal(sends.length, 2);
  assert.deepEqual(new Set(sends.map((item) => item.token)), new Set([activeToken, otherLanguageToken]));
  assert.equal(sends[0].notification.title, '🔴 Breaking News');
  assert.equal(sends[0].notification.body, 'Breaking news message');
  assert.equal(sends[0].data.deliveryLogId, String(logs[0]._id));
  assert.deepEqual({
    deliveryLogId: sends[0].data.deliveryLogId,
    type: sends[0].data.type,
    title: sends[0].data.title,
    body: sends[0].data.body,
    url: sends[0].data.url,
  }, {
    deliveryLogId: String(logs[0]._id),
    type: 'breaking',
    title: '🔴 Breaking News',
    body: 'Breaking news message',
    url: 'https://www.newspulse.co.in/',
  });
  assert.equal(sends[0].data.type, 'breaking');
  assert.equal(sends[0].data.title, '🔴 Breaking News');
  assert.equal(sends[0].data.body, 'Breaking news message');
  assert.equal(sends[0].data.url, 'https://www.newspulse.co.in/');
  assert.equal(sends[0].webpush.fcmOptions.link, 'https://www.newspulse.co.in/');
  assert.equal(sends[0].webpush.headers.TTL, '120');
  assert.equal(sends[0].webpush.headers.Urgency, 'high');
  assert.deepEqual(sendObservations, [
    { deliveryLogId: String(logs[0]._id), deliveryLogExistsBeforeSend: true },
    { deliveryLogId: String(logs[0]._id), deliveryLogExistsBeforeSend: true },
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, 'breaking');
  assert.equal(logs[0].status, 'sent');
  assert.equal(logs[0].reason, null);
  assert.equal(logs[0].title, '🔴 Breaking News');
  assert.equal(logs[0].body, 'Breaking news message');
  assert.equal(logs[0].url, 'https://www.newspulse.co.in/');
  assert.equal(logs[0].language, 'en');
  assert.equal(logs[0].targetedCount, 2);
  assert.equal(logs[0].hasDeliveryLogId, true);
  assert.equal(logs[0].payloadType, 'breaking');
  assert.equal(logs[0].ttlSeconds, 120);
  assert.equal(logs[0].metadata.targeting.breakingNewsSubscribers, 2);
  assert.equal(logs[0].metadata.targeting.excludedFidOnlyCount, 1);
  assert.equal(Boolean(logs[0].fcmAcceptedAt), true);
  assert.equal(typeof logs[0].fcmLatencyMs, 'number');
  assert.equal(Array.from(docs.values()).find((item) => item.registrationId === disabledToken).enabled, false);
  assert.equal(Boolean(logs[0].completedAt), true);
  assertNoPushSecrets(response.body, [activeToken, otherLanguageToken, preferenceOffToken, disabledToken, activeFid, process.env.FIREBASE_PRIVATE_KEY]);
  assertNoPushSecrets(logs, [activeToken, otherLanguageToken, preferenceOffToken, disabledToken, activeFid, process.env.FIREBASE_PRIVATE_KEY]);
});

test('POST /api/admin/push/breaking records no recipients when no breakingNews registrations are eligible', async () => {
  const preferenceOffToken = 'fcm-token-breaking-no-recipient:defghijklmnopqrstuvwxyz0123456789';
  const fid = 'firebase-installation-breaking-no-recipient';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({ token: preferenceOffToken, preferences: { breakingNews: false } });
  await request(app).post('/api/public/push/register').send({ registrationId: fid, registrationType: 'fid', preferences: { breakingNews: true } });

  const response = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      title: 'Breaking News',
      body: 'Breaking news message',
      url: 'https://www.newspulse.co.in/news/breaking-no-recipient',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, false);
  assert.equal(response.body.status, 'no_recipients');
  assert.equal(response.body.reason, 'no_breaking_news_subscribers');
  assert.equal(response.body.targetedCount, 0);
  assert.equal(response.body.successCount, 0);
  assert.equal(response.body.failureCount, 0);
  assert.equal(response.body.targetingDebug.breakingNewsSubscribers, 0);
  assert.equal(response.body.targetingDebug.excludedPreferenceOffCount, 1);
  assert.equal(response.body.targetingDebug.excludedFidOnlyCount, 1);
  assert.equal(response.body.targetingDebug.targetedCount, 0);
  assert.equal(sends.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'no_recipients');
  assert.equal(logs[0].reason, 'no_breaking_news_subscribers');
  assert.equal(logs[0].targetedCount, 0);
  assert.equal(logs[0].metadata.targeting.breakingNewsSubscribers, 0);
  assert.equal(logs[0].metadata.targeting.excludedFidOnlyCount, 1);
  assertNoPushSecrets(response.body, [preferenceOffToken, fid, process.env.FIREBASE_PRIVATE_KEY]);
  assertNoPushSecrets(logs, [preferenceOffToken, fid, process.env.FIREBASE_PRIVATE_KEY]);
});

test('POST /api/admin/push/breaking blocks duplicate breaking text within cooldown', async () => {
  const token = 'fcm-token-breaking-duplicate:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('breaking-duplicate@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const first = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', auth)
    .send({ body: 'Duplicate breaking text', language: 'en', confirmSend: true });
  const duplicate = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', auth)
    .send({ body: 'Duplicate breaking text', language: 'en', confirmSend: true });

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_PUSH_BLOCKED');
  assert.equal(duplicate.body.message, 'Duplicate push blocked. Please wait before sending again.');
  assert.equal(sends.length, 1);
  assert.equal(logs.length, 1);
  assertNoPushSecrets(duplicate.body, [token]);
});

test('POST /api/admin/push/breaking allows different breaking text before cooldown', async () => {
  const token = 'fcm-token-breaking-different:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('breaking-different@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const first = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', auth)
    .send({ body: 'Different breaking text A', language: 'en', confirmSend: true });
  const second = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', auth)
    .send({ body: 'Different breaking text B', language: 'en', confirmSend: true });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(sends.length, 2);
  assert.equal(logs.length, 2);
  assertNoPushSecrets([first.body, second.body], [token]);
});

test('POST /api/admin/push/breaking rate limits after three sends per admin and IP', async () => {
  const token = 'fcm-token-breaking-rate:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('breaking-rate@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const responses = [];
  for (let index = 1; index <= 4; index += 1) {
    responses.push(await request(app)
      .post('/api/admin/push/breaking')
      .set('Authorization', auth)
      .send({ body: `Breaking rate text ${index}`, language: 'en', confirmSend: true }));
  }

  assert.deepEqual(responses.map((item) => item.status), [200, 200, 200, 429]);
  assert.equal(responses[3].body.code, 'PUSH_RATE_LIMITED');
  assert.equal(sends.length, 3);
  assert.equal(logs.length, 3);
  assertNoPushSecrets(responses.map((item) => item.body), [token]);
});

test('POST /api/admin/push/breaking ignores unsafe submitted URL and uses safe root URL', async () => {
  const { sends } = installFirebaseSendStub();
  const { logs } = installInMemoryDeliveryLogStore();
  installInMemoryRegistrationStore();
  await request(app).post('/api/public/push/register').send({ token: 'fcm-token-breaking-safe-url:defghijklmnopqrstuvwxyz0123456789' });

  const response = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      title: 'Breaking News',
      body: 'Breaking news message',
      url: 'https://evil.example/news/breaking',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.targetedCount, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].data.url, 'https://www.newspulse.co.in/');
  assert.equal(sends[0].webpush.fcmOptions.link, 'https://www.newspulse.co.in/');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].url, 'https://www.newspulse.co.in/');
  assertNoPushSecrets(response.body, ['fcm-token-breaking-safe-url:defghijklmnopqrstuvwxyz0123456789']);
  assertNoPushSecrets(logs, ['fcm-token-breaking-safe-url:defghijklmnopqrstuvwxyz0123456789']);
});

test('POST /api/admin/push/article sends article push and diagnostics show last success', async () => {
  const token = 'fcm-token-article:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({ token, language: 'gu' });

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      articleId: 'article-1',
      slug: 'article-slug',
      title: 'Article title',
      body: 'Article summary',
      url: 'https://www.newspulse.co.in/news/article-slug',
      category: 'national',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.type, 'article');
  assert.equal(response.body.status, 'sent');
  assert.equal(response.body.deliveryProofStatus, 'fcm_accepted');
  assert.equal(response.body.reason, null);
  assert.equal(response.body.targetedCount, 1);
  assert.equal(response.body.successCount, 1);
  assert.equal(typeof response.body.fcmAcceptedAt, 'string');
  assert.equal(typeof response.body.fcmLatencyMs, 'number');
  assert.equal(response.body.targetingDebug.enabledDevices, 1);
  assert.equal(response.body.targetingDebug.newArticleAlertEligibleDevices, 1);
  assert.equal(response.body.targetingDebug.excludedDisabledCount, 0);
  assert.equal(response.body.targetingDebug.excludedPreferenceOffCount, 0);
  assert.equal(response.body.deliveryLogCreated, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].data.deliveryLogId, String(logs[0]._id));
  assert.deepEqual({
    deliveryLogId: sends[0].data.deliveryLogId,
    type: sends[0].data.type,
    title: sends[0].data.title,
    body: sends[0].data.body,
    url: sends[0].data.url,
  }, {
    deliveryLogId: String(logs[0]._id),
    type: 'article',
    title: 'Article title',
    body: 'Article summary',
    url: 'https://www.newspulse.co.in/news/article-slug',
  });
  assert.equal(sends[0].data.type, 'article');
  assert.equal(sends[0].data.title, 'Article title');
  assert.equal(sends[0].data.body, 'Article summary');
  assert.equal(sends[0].data.url, 'https://www.newspulse.co.in/news/article-slug');
  assert.equal(sends[0].data.articleId, 'article-1');
  assert.equal(sends[0].data.articleSlug, 'article-slug');
  assert.equal(sends[0].data.category, 'national');
  assert.equal(sends[0].webpush.headers.TTL, '1800');
  assert.equal(sends[0].webpush.headers.Urgency, 'normal');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, 'article');
  assert.equal(logs[0].status, 'sent');
  assert.equal(logs[0].reason, null);
  assert.equal(logs[0].articleId, 'article-1');
  assert.equal(logs[0].articleSlug, 'article-slug');
  assert.equal(logs[0].category, 'national');
  assert.equal(logs[0].language, 'en');
  assert.equal(Boolean(logs[0].fcmAcceptedAt), true);
  assert.equal(typeof logs[0].fcmLatencyMs, 'number');

  const diagnostics = await request(app).get('/api/public/push/diagnostics');
  assert.equal(diagnostics.status, 200);
  assert.equal(typeof diagnostics.body.lastSuccessfulSendAt, 'string');
  assertNoPushSecrets(response.body, [token, process.env.FIREBASE_PRIVATE_KEY]);
  assertNoPushSecrets(diagnostics.body, [token, process.env.FIREBASE_PRIVATE_KEY]);
});

test('POST /api/admin/push/article blocks duplicate articleId or slug within cooldown', async () => {
  const token = 'fcm-token-article-duplicate:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('article-duplicate@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const payload = {
    articleId: 'article-duplicate-id',
    slug: 'article-duplicate-slug',
    title: 'Duplicate article title',
    body: 'Duplicate article summary',
    url: 'https://www.newspulse.co.in/news/article-duplicate-slug',
    category: 'national',
    language: 'en',
    confirmSend: true,
  };
  const first = await request(app).post('/api/admin/push/article').set('Authorization', auth).send(payload);
  const duplicate = await request(app).post('/api/admin/push/article').set('Authorization', auth).send({ ...payload, body: 'Updated summary' });

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_PUSH_BLOCKED');
  assert.equal(duplicate.body.message, 'Duplicate push blocked. Please wait before sending again.');
  assert.equal(sends.length, 1);
  assert.equal(logs.length, 1);
  assertNoPushSecrets(duplicate.body, [token]);
});

test('POST /api/admin/push/article allows different articles before cooldown', async () => {
  const token = 'fcm-token-article-different:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('article-different@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const first = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', auth)
    .send({ articleId: 'article-different-1', slug: 'article-different-1', title: 'Article one', body: 'Article one summary', url: 'https://www.newspulse.co.in/news/article-different-1', category: 'national', language: 'en', confirmSend: true });
  const second = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', auth)
    .send({ articleId: 'article-different-2', slug: 'article-different-2', title: 'Article two', body: 'Article two summary', url: 'https://www.newspulse.co.in/news/article-different-2', category: 'national', language: 'en', confirmSend: true });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(sends.length, 2);
  assert.equal(logs.length, 2);
  assertNoPushSecrets([first.body, second.body], [token]);
});

test('POST /api/admin/push/article rate limits after ten sends per admin and IP', async () => {
  const token = 'fcm-token-article-rate:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();
  const auth = `Bearer ${makeOpaqueAdminToken('article-rate@newspulse.ai')}`;

  await request(app).post('/api/public/push/register').send({ token });

  const responses = [];
  for (let index = 1; index <= 11; index += 1) {
    responses.push(await request(app)
      .post('/api/admin/push/article')
      .set('Authorization', auth)
      .send({
        articleId: `article-rate-${index}`,
        slug: `article-rate-${index}`,
        title: `Article rate ${index}`,
        body: `Article rate summary ${index}`,
        url: `https://www.newspulse.co.in/news/article-rate-${index}`,
        category: 'national',
        language: 'en',
        confirmSend: true,
      }));
  }

  assert.deepEqual(responses.map((item) => item.status), [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);
  assert.equal(responses[10].body.code, 'PUSH_RATE_LIMITED');
  assert.equal(sends.length, 10);
  assert.equal(logs.length, 10);
  assertNoPushSecrets(responses.map((item) => item.body), [token]);
});

test('POST /api/admin/push/article targets token registrations with newArticleAlerts only', async () => {
  const eligibleToken = 'fcm-token-article-eligible:defghijklmnopqrstuvwxyz0123456789';
  const preferenceOffToken = 'fcm-token-article-pref-off:defghijklmnopqrstuvwxyz0123456789';
  const disabledToken = 'fcm-token-article-disabled:defghijklmnopqrstuvwxyz0123456789';
  const eligibleFid = 'firebase-installation-article-eligible';
  const { docs } = installInMemoryRegistrationStore();
  installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({
    token: eligibleToken,
    language: 'gu',
    preferences: { newArticleAlerts: true, categoryAlerts: false, allArticles: false },
    categories: ['sports'],
  });
  await request(app).post('/api/public/push/register').send({ token: preferenceOffToken, language: 'en', preferences: { newArticleAlerts: false } });
  await request(app).post('/api/public/push/register').send({ token: disabledToken, language: 'en' });
  await request(app).post('/api/public/push/register').send({ registrationId: eligibleFid, registrationType: 'fid', language: 'hi' });
  const unregister = await request(app).post('/api/public/push/unregister').send({ token: disabledToken });
  assert.equal(unregister.status, 200);
  assert.equal(unregister.body.disabled, true);

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      articleId: 'article-targeting',
      slug: 'article-targeting',
      title: 'Article title',
      body: 'Article summary',
      url: 'https://www.newspulse.co.in/news/article-targeting',
      category: 'national',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.targetedCount, 1);
  assert.equal(response.body.successCount, 1);
  assert.equal(response.body.deliveryProofStatus, 'fcm_accepted');
  assert.equal(response.body.failureCount, 0);
  assert.equal(response.body.targetingDebug.enabledDevices, 2);
  assert.equal(response.body.targetingDebug.newArticleAlertEligibleDevices, 1);
  assert.equal(response.body.targetingDebug.excludedDisabledCount, 1);
  assert.equal(response.body.targetingDebug.excludedPreferenceOffCount, 1);
  assert.equal(response.body.targetingDebug.targetedCount, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].token, eligibleToken);
  assert.equal(Array.from(docs.values()).find((item) => item.registrationId === disabledToken).enabled, false);
  assertNoPushSecrets(response.body, [eligibleToken, preferenceOffToken, disabledToken, eligibleFid, process.env.FIREBASE_PRIVATE_KEY]);
});

test('POST /api/admin/push/article records no recipients when no newArticleAlerts registrations are eligible', async () => {
  const preferenceOffToken = 'fcm-token-article-no-recipient:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  const { sends } = installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({ token: preferenceOffToken, preferences: { newArticleAlerts: false } });

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      articleId: 'article-no-recipient',
      slug: 'article-no-recipient',
      title: 'Article title',
      body: 'Article summary',
      url: 'https://www.newspulse.co.in/news/article-no-recipient',
      category: 'national',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, false);
  assert.equal(response.body.status, 'no_recipients');
  assert.equal(response.body.deliveryProofStatus, 'no_recipients');
  assert.equal(response.body.reason, 'no_article_alert_subscribers');
  assert.equal(response.body.targetedCount, 0);
  assert.equal(response.body.successCount, 0);
  assert.equal(response.body.failureCount, 0);
  assert.equal(response.body.targetingDebug.enabledDevices, 1);
  assert.equal(response.body.targetingDebug.newArticleAlertEligibleDevices, 0);
  assert.equal(response.body.targetingDebug.excludedPreferenceOffCount, 1);
  assert.equal(response.body.targetingDebug.targetedCount, 0);
  assert.equal(sends.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'no_recipients');
  assert.equal(logs[0].reason, 'no_article_alert_subscribers');
  assert.equal(logs[0].targetedCount, 0);
  assert.equal(logs[0].metadata.targeting.targetedCount, 0);
  assertNoPushSecrets(response.body, [preferenceOffToken]);
  assertNoPushSecrets(logs, [preferenceOffToken]);
});

test('POST /api/admin/push/article stores safe Firebase failure code and metadata', async () => {
  const token = 'fcm-token-article-failure:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  installFirebaseSendStub({ failCode: 'messaging/internal-error', failMessage: `Firebase rejected ${token}` });
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map((item) => String(item)).join(' ')); };

  await request(app).post('/api/public/push/register').send({ token });

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      articleId: 'article-failure',
      slug: 'article-failure',
      title: 'Article title',
      body: 'Article summary',
      url: 'https://www.newspulse.co.in/news/article-failure',
      category: 'national',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, false);
  assert.equal(response.body.deliveryProofStatus, 'failed');
  assert.equal(response.body.targetedCount, 1);
  assert.equal(response.body.failureCount, 1);
  assert.equal(response.body.lastFailureCode, 'messaging/internal-error');
  assert.equal(response.body.lastFailureMessage, 'Firebase rejected [redacted-registration-id]');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].lastFailureCode, 'messaging/internal-error');
  assert.equal(logs[0].lastFailureMessage, 'Firebase rejected [redacted-registration-id]');
  assert.equal(logs[0].failureCount, 1);
  assert.equal(Boolean(logs[0].completedAt), true);
  assert.deepEqual(logs[0].metadata.firebaseFailures, [{ code: 'messaging/internal-error', message: 'Firebase rejected [redacted-registration-id]', count: 1 }]);
  assert.equal(logs[0].metadata.targeting.enabledDevices, 1);
  assert.equal(logs[0].metadata.targeting.newArticleAlertEligibleDevices, 1);
  assert.equal(logs[0].metadata.targeting.targetedCount, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], 'Push send failed: code=messaging/internal-error, failures=1');
  assert.equal(warnings[0].includes(token), false);
  assertNoPushSecrets(response.body, [token, process.env.FIREBASE_PRIVATE_KEY, process.env.FIREBASE_CLIENT_EMAIL]);
  assertNoPushSecrets(logs, [token, process.env.FIREBASE_PRIVATE_KEY, process.env.FIREBASE_CLIENT_EMAIL]);
});

test('invalid Firebase token disables only that registration during article push', async () => {
  const invalidToken = 'fcm-token-invalid-article:defghijklmnopqrstuvwxyz0123456789';
  const validToken = 'fcm-token-valid-article:defghijklmnopqrstuvwxyz0123456789';
  const { docs } = installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  installFirebaseSendStub({
    failByToken: {
      [invalidToken]: { code: 'messaging/registration-token-not-registered', message: 'Requested entity was not found.' },
    },
  });

  await request(app).post('/api/public/push/register').send({ token: invalidToken });
  await request(app).post('/api/public/push/register').send({ token: validToken });

  const response = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({
      articleId: 'article-invalid-token',
      slug: 'article-invalid-token',
      title: 'Article title',
      body: 'Article summary',
      url: 'https://www.newspulse.co.in/news/article-invalid-token',
      category: 'national',
      language: 'en',
      confirmSend: true,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.targetedCount, 2);
  assert.equal(response.body.successCount, 1);
  assert.equal(response.body.deliveryProofStatus, 'fcm_accepted');
  assert.equal(response.body.failureCount, 1);
  assert.equal(response.body.lastFailureCode, 'messaging/registration-token-not-registered');
  const invalid = Array.from(docs.values()).find((item) => item.registrationId === invalidToken);
  const valid = Array.from(docs.values()).find((item) => item.registrationId === validToken);
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.status, 'inactive');
  assert.equal(Boolean(invalid.disabledAt), true);
  assert.equal(invalid.lastFailureCode, 'messaging/registration-token-not-registered');
  assert.equal(valid.enabled, true);
  assert.equal(valid.status, 'active');
  assert.equal(Boolean(valid.lastSuccessfulSendAt), true);
  assert.equal(logs[0].lastFailureCode, 'messaging/registration-token-not-registered');
  assertNoPushSecrets(response.body, [invalidToken, validToken]);
  assertNoPushSecrets(logs, [invalidToken, validToken]);
});

test('GET /api/admin/push/history returns empty items when no delivery logs exist', async () => {
  installInMemoryRegistrationStore();
  installInMemoryDeliveryLogStore();

  const response = await request(app)
    .get('/api/admin/push/history')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
});

test('POST /api/public/push/receipt records received, shown, clicked, and display_failed events safely', async () => {
  const token = 'fcm-token-receipt-secret:defghijklmnopqrstuvwxyz0123456789';
  const { logs } = installInMemoryDeliveryLogStore();
  const log = await PushDeliveryLog.create(makeDeliveryLog(42, {
    browserReceivedCount: 0,
    notificationShownCount: 0,
    clickedCount: 0,
    displayFailedCount: 0,
    firstReceivedAt: null,
    lastReceivedAt: null,
    firstShownAt: null,
    lastShownAt: null,
    firstClickedAt: null,
    lastClickedAt: null,
    sentAt: new Date(Date.now() - 10_000).toISOString(),
  }));

  const firstReceived = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'received' });
  assert.equal(firstReceived.status, 200);
  assert.equal(firstReceived.body.ok, true);

  const initialFirstReceivedAt = logs[0].firstReceivedAt;
  const initialLastReceivedAt = logs[0].lastReceivedAt;
  assert.equal(logs[0].browserReceivedCount, 1);
  assert.equal(Boolean(initialFirstReceivedAt), true);
  assert.equal(Boolean(initialLastReceivedAt), true);
  assert.equal(typeof logs[0].firstBrowserReceivedLatencyMs, 'number');
  assert.ok(logs[0].firstBrowserReceivedLatencyMs >= 0);

  const secondReceived = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'received' });
  assert.equal(secondReceived.status, 200);
  assert.equal(logs[0].browserReceivedCount, 2);
  assert.equal(logs[0].firstReceivedAt, initialFirstReceivedAt);
  assert.notEqual(logs[0].lastReceivedAt, null);

  const firstShown = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'shown' });
  assert.equal(firstShown.status, 200);
  const initialFirstShownAt = logs[0].firstShownAt;
  assert.equal(logs[0].notificationShownCount, 1);
  assert.equal(Boolean(initialFirstShownAt), true);
  assert.equal(Boolean(logs[0].lastShownAt), true);
  assert.equal(typeof logs[0].firstNotificationShownLatencyMs, 'number');
  assert.ok(logs[0].firstNotificationShownLatencyMs >= 0);

  const secondShown = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'shown' });
  assert.equal(secondShown.status, 200);
  assert.equal(logs[0].notificationShownCount, 2);
  assert.equal(logs[0].firstShownAt, initialFirstShownAt);

  const firstClicked = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'clicked' });
  assert.equal(firstClicked.status, 200);
  const initialFirstClickedAt = logs[0].firstClickedAt;
  assert.equal(logs[0].clickedCount, 1);
  assert.equal(Boolean(initialFirstClickedAt), true);
  assert.equal(Boolean(logs[0].lastClickedAt), true);
  assert.equal(typeof logs[0].firstClickLatencyMs, 'number');
  assert.ok(logs[0].firstClickLatencyMs >= 0);

  const secondClicked = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'clicked' });
  assert.equal(secondClicked.status, 200);
  assert.equal(logs[0].clickedCount, 2);
  assert.equal(logs[0].firstClickedAt, initialFirstClickedAt);

  const displayFailed = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'display_failed', reason: `Permission denied for token=${token}` });
  assert.equal(displayFailed.status, 200);
  assert.equal(logs[0].displayFailedCount, 1);
  assert.equal(logs[0].lastDisplayFailureReason, 'Permission denied for token=[redacted]');
  assertNoPushSecrets(firstReceived.body, [token]);
  assertNoPushSecrets(secondShown.body, [token]);
  assertNoPushSecrets(secondClicked.body, [token]);
  assertNoPushSecrets(displayFailed.body, [token]);
  assertNoPushSecrets(logs, [token]);
});

test('POST /api/public/push/receipt preserves first timestamps and advances last timestamps', async () => {
  const { logs } = installInMemoryDeliveryLogStore();
  const firstReceivedAt = '2026-08-13T09:00:00.000Z';
  const lastReceivedAt = '2026-08-13T09:01:00.000Z';
  const firstShownAt = '2026-08-13T09:01:30.000Z';
  const lastShownAt = '2026-08-13T09:01:45.000Z';
  const firstClickedAt = '2026-08-13T09:02:00.000Z';
  const lastClickedAt = '2026-08-13T09:03:00.000Z';
  const log = await PushDeliveryLog.create(makeDeliveryLog(43, {
    browserReceivedCount: 3,
    notificationShownCount: 2,
    clickedCount: 2,
    firstReceivedAt,
    lastReceivedAt,
    firstShownAt,
    lastShownAt,
    firstClickedAt,
    lastClickedAt,
  }));

  const received = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'received' });
  assert.equal(received.status, 200);
  assert.equal(logs[0].browserReceivedCount, 4);
  assert.equal(logs[0].firstReceivedAt, firstReceivedAt);
  assert.notEqual(logs[0].lastReceivedAt, lastReceivedAt);

  const shown = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'shown' });
  assert.equal(shown.status, 200);
  assert.equal(logs[0].notificationShownCount, 3);
  assert.equal(logs[0].firstShownAt, firstShownAt);
  assert.notEqual(logs[0].lastShownAt, lastShownAt);

  const clicked = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: String(log._id), event: 'clicked' });
  assert.equal(clicked.status, 200);
  assert.equal(logs[0].clickedCount, 3);
  assert.equal(logs[0].firstClickedAt, firstClickedAt);
  assert.notEqual(logs[0].lastClickedAt, lastClickedAt);
  assertNoPushSecrets(received.body);
  assertNoPushSecrets(shown.body);
  assertNoPushSecrets(clicked.body);
});

test('POST /api/public/push/receipt rejects invalid input safely', async () => {
  installInMemoryDeliveryLogStore();

  const invalidId = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: 'not-a-log-id', event: 'received' });
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.code, 'INVALID_PUSH_RECEIPT');

  const invalidEvent = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: '000000000000000000000001', event: 'opened' });
  assert.equal(invalidEvent.status, 400);
  assert.equal(invalidEvent.body.code, 'INVALID_PUSH_RECEIPT');

  const missingLog = await request(app)
    .post('/api/public/push/receipt')
    .send({ deliveryLogId: '000000000000000000000001', event: 'received' });
  assert.equal(missingLog.status, 404);
  assert.equal(missingLog.body.code, 'PUSH_DELIVERY_LOG_NOT_FOUND');
  assertNoPushSecrets(invalidId.body);
  assertNoPushSecrets(invalidEvent.body);
  assertNoPushSecrets(missingLog.body);
});

test('GET /api/admin/push/history returns breaking/article logs newest first without identifiers', async () => {
  const breakingToken = 'fcm-token-history-breaking:defghijklmnopqrstuvwxyz0123456789';
  const articleToken = 'fcm-token-history-article:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  installFirebaseSendStub();

  await request(app).post('/api/public/push/register').send({ token: breakingToken });
  await request(app).post('/api/public/push/register').send({ token: articleToken });

  const breaking = await request(app)
    .post('/api/admin/push/breaking')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ title: 'Breaking News', body: 'Breaking news message', url: 'https://www.newspulse.co.in/news/breaking', language: 'en', confirmSend: true });
  assert.equal(breaking.status, 200);
  logs[0].sentAt = '2026-08-13T10:00:00.000Z';

  const article = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ articleId: 'article-2', slug: 'article-newest', title: 'Article title', body: 'Article summary', url: 'https://www.newspulse.co.in/news/article-newest', category: 'national', language: 'en', confirmSend: true });
  assert.equal(article.status, 200);
  logs[1].sentAt = '2026-08-13T11:00:00.000Z';

  const response = await request(app)
    .get('/api/admin/push/history?limit=10')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.items[0].type, 'article');
  assert.equal(response.body.items[0].articleSlug, 'article-newest');
  assert.equal(response.body.items[1].type, 'breaking');
  assert.equal(response.body.items[0].targetedCount, 2);
  assert.equal(response.body.items[0].successCount, 2);
  assert.equal(response.body.items[1].hasDeliveryLogId, true);
  assert.equal(response.body.items[1].payloadType, 'breaking');
  assert.equal(response.body.items[1].ttlSeconds, 120);
  assert.equal(response.body.items[1].browserReceivedCount, 0);
  logs[1].browserReceivedCount = 2;
  logs[1].notificationShownCount = 1;
  logs[1].clickedCount = 1;
  logs[1].displayFailedCount = 1;
  logs[1].firstReceivedAt = '2026-08-13T11:01:00.000Z';
  logs[1].lastReceivedAt = '2026-08-13T11:02:00.000Z';
  logs[1].firstShownAt = '2026-08-13T11:02:30.000Z';
  logs[1].lastShownAt = '2026-08-13T11:02:45.000Z';
  logs[1].firstClickedAt = '2026-08-13T11:03:00.000Z';
  logs[1].lastClickedAt = '2026-08-13T11:04:00.000Z';
  logs[1].firstNotificationShownLatencyMs = 150000;
  logs[1].lastDisplayFailureReason = 'permission denied';

  const proofResponse = await request(app)
    .get('/api/admin/push/history?limit=10')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(proofResponse.status, 200);
  assert.equal(proofResponse.body.items[0].browserReceivedCount, 2);
  assert.equal(proofResponse.body.items[0].notificationShownCount, 1);
  assert.equal(proofResponse.body.items[0].clickedCount, 1);
  assert.equal(proofResponse.body.items[0].displayFailedCount, 1);
  assert.equal(proofResponse.body.items[0].deliveryProofStatus, 'clicked');
  assert.equal(proofResponse.body.items[0].firstReceivedAt, '2026-08-13T11:01:00.000Z');
  assert.equal(proofResponse.body.items[0].lastReceivedAt, '2026-08-13T11:02:00.000Z');
  assert.equal(proofResponse.body.items[0].firstShownAt, '2026-08-13T11:02:30.000Z');
  assert.equal(proofResponse.body.items[0].lastShownAt, '2026-08-13T11:02:45.000Z');
  assert.equal(proofResponse.body.items[0].firstClickedAt, '2026-08-13T11:03:00.000Z');
  assert.equal(proofResponse.body.items[0].lastClickedAt, '2026-08-13T11:04:00.000Z');
  assert.equal(typeof proofResponse.body.items[0].fcmLatencyMs, 'number');
  assert.equal(proofResponse.body.items[0].firstBrowserReceivedLatencyMs, null);
  assert.equal(proofResponse.body.items[0].firstNotificationShownLatencyMs, 150000);
  assert.equal(proofResponse.body.items[0].firstClickLatencyMs, null);
  assert.equal(proofResponse.body.items[0].lastDisplayFailureReason, 'permission denied');
  assert.equal(response.body.items[0].deliveryProofStatus, 'fcm_accepted');
  assert.equal(response.body.items[0].lastFailureCode, null);
  assert.equal(response.body.items[0].lastFailureMessage, null);
  assert.equal(JSON.stringify(proofResponse.body).includes('registrationId'), false);
  assert.equal(JSON.stringify(proofResponse.body).includes('firebaseInstallationId'), false);
  assertNoPushSecrets(response.body, [breakingToken, articleToken, process.env.FIREBASE_PRIVATE_KEY, process.env.FIREBASE_CLIENT_EMAIL]);
  assertNoPushSecrets(proofResponse.body, [breakingToken, articleToken, process.env.FIREBASE_PRIVATE_KEY, process.env.FIREBASE_CLIENT_EMAIL]);
});

test('GET /api/admin/push/history reports shown proof status before clicks', async () => {
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  logs.push(makeDeliveryLog(44, {
    browserReceivedCount: 1,
    notificationShownCount: 1,
    clickedCount: 0,
    firstShownAt: '2026-08-13T12:01:00.000Z',
    lastShownAt: '2026-08-13T12:01:30.000Z',
    firstNotificationShownLatencyMs: 60000,
  }));

  const response = await request(app)
    .get('/api/admin/push/history')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].deliveryProofStatus, 'shown');
  assert.equal(response.body.items[0].notificationShownCount, 1);
  assert.equal(response.body.items[0].firstShownAt, '2026-08-13T12:01:00.000Z');
  assert.equal(response.body.items[0].lastShownAt, '2026-08-13T12:01:30.000Z');
  assert.equal(response.body.items[0].firstNotificationShownLatencyMs, 60000);
  assertNoPushSecrets(response.body);
});

test('GET /api/admin/push/history returns safe failure code/message without identifiers', async () => {
  const token = 'fcm-token-history-failure:defghijklmnopqrstuvwxyz0123456789';
  installInMemoryRegistrationStore();
  installInMemoryDeliveryLogStore();
  installFirebaseSendStub({ failCode: 'messaging/mismatched-credential', failMessage: `Could not send to ${token}` });

  await request(app).post('/api/public/push/register').send({ token });
  const article = await request(app)
    .post('/api/admin/push/article')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`)
    .send({ articleId: 'article-history-failure', slug: 'article-history-failure', title: 'Article title', body: 'Article summary', url: 'https://www.newspulse.co.in/news/article-history-failure', category: 'national', language: 'en', confirmSend: true });
  assert.equal(article.status, 200);

  const response = await request(app)
    .get('/api/admin/push/history?status=failed')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].lastFailureCode, 'messaging/mismatched-credential');
  assert.equal(response.body.items[0].lastFailureMessage, 'Could not send to [redacted-registration-id]');
  assert.equal(response.body.items[0].failureCount, 1);
  assert.equal(JSON.stringify(response.body).includes('registrationId'), false);
  assert.equal(JSON.stringify(response.body).includes('firebaseInstallationId'), false);
  assertNoPushSecrets(response.body, [token, process.env.FIREBASE_PRIVATE_KEY, process.env.FIREBASE_CLIENT_EMAIL]);
});

test('GET /api/admin/push/history defaults to latest 5 records with pagination', async () => {
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  for (let index = 1; index <= 7; index += 1) logs.push(makeDeliveryLog(index));

  const response = await request(app)
    .get('/api/admin/push/history')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 5);
  assert.equal(response.body.items[0].title, 'Push 7');
  assert.equal(response.body.items[4].title, 'Push 3');
  assert.deepEqual(response.body.pagination, { page: 1, limit: 5, total: 7, totalPages: 2 });
});

test('GET /api/admin/push/history supports limit=20 and enforces max limit 50', async () => {
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  for (let index = 1; index <= 55; index += 1) logs.push(makeDeliveryLog(index));

  const fullPage = await request(app)
    .get('/api/admin/push/history?limit=20')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(fullPage.status, 200);
  assert.equal(fullPage.body.items.length, 20);
  assert.equal(fullPage.body.pagination.limit, 20);
  assert.equal(fullPage.body.pagination.total, 55);
  assert.equal(fullPage.body.pagination.totalPages, 3);

  const capped = await request(app)
    .get('/api/admin/push/history?limit=500')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(capped.status, 200);
  assert.equal(capped.body.items.length, 50);
  assert.equal(capped.body.pagination.limit, 50);
  assert.equal(capped.body.pagination.totalPages, 2);
});

test('GET /api/admin/push/history filters no-recipient sends safely', async () => {
  installInMemoryRegistrationStore();
  const { logs } = installInMemoryDeliveryLogStore();
  logs.push(makeDeliveryLog(1, { targetedCount: 0, successCount: 0, failureCount: 0, title: 'No recipients' }));
  logs.push(makeDeliveryLog(2, { targetedCount: 2, successCount: 1, failureCount: 1, title: 'Partial send' }));

  const response = await request(app)
    .get('/api/admin/push/history?status=no_recipients')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].title, 'No recipients');
  assert.equal(response.body.items[0].targetedCount, 0);
  assert.deepEqual(response.body.pagination, { page: 1, limit: 5, total: 1, totalPages: 1 });
});

test('PushDeliveryLog retention defaults to 30 days and only applies to delivery logs', () => {
  const indexes = PushDeliveryLog.schema.indexes();
  const ttlIndex = indexes.find(([fields, options]) => fields.sentAt === 1 && options?.name === 'push_delivery_log_retention_ttl');

  assert.equal(typeof PushDeliveryLog.getHistoryRetentionDays, 'function');
  assert.equal(PushDeliveryLog.getHistoryRetentionDays(), 30);
  assert.ok(ttlIndex);
  assert.equal(ttlIndex[1].expireAfterSeconds, 30 * 24 * 60 * 60);

  const registrationTtlIndex = PushRegistration.schema.indexes().find(([, options]) => options?.name === 'push_delivery_log_retention_ttl' || options?.expireAfterSeconds);
  assert.equal(registrationTtlIndex, undefined);
});

test('Firebase send success updates registration health', async () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  let update = null;
  PushRegistration.updateOne = async (_filter, value) => { update = value; return { modifiedCount: 1 }; };
  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [{ options: { projectId: 'news-pulse-test' } }],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: () => { throw new Error('should not initialize'); },
    },
    messagingModule: { getMessaging: () => ({ send: async () => 'message-id-1' }) },
  });

  const result = await pushMessagingService.sendPushToRegistration({
    _id: 'push-1',
    registrationId: 'fcm-token-success:defghijklmnopqrstuvwxyz0123456789',
    registrationType: 'token',
    enabled: true,
    status: 'active',
  }, { title: 'News Pulse', body: 'Works', url: 'https://www.newspulse.co.in/news/test' });

  assert.equal(result.success, true);
  assert.equal(update.$set.lastFailureAt, null);
  assert.equal(update.$set.status, 'active');
});

test('invalid Firebase registration is marked inactive', async () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  let update = null;
  PushRegistration.updateOne = async (_filter, value) => { update = value; return { modifiedCount: 1 }; };
  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [{ options: { projectId: 'news-pulse-test' } }],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: () => { throw new Error('should not initialize'); },
    },
    messagingModule: {
      getMessaging: () => ({
        send: async () => {
          const error = new Error('registration token not registered');
          error.code = 'messaging/registration-token-not-registered';
          throw error;
        },
      }),
    },
  });

  const result = await pushMessagingService.sendPushToRegistration({
    _id: 'push-1',
    registrationId: 'fcm-token-invalid:defghijklmnopqrstuvwxyz0123456789',
    registrationType: 'token',
    enabled: true,
    status: 'active',
  }, { title: 'News Pulse', body: 'Works', url: 'https://www.newspulse.co.in/news/test' });

  assert.equal(result.success, false);
  assert.equal(result.permanent, true);
  assert.equal(update.$set.enabled, false);
  assert.equal(update.$set.status, 'inactive');
});

test('temporary Firebase failure does not disable registration', async () => {
  process.env.FIREBASE_PROJECT_ID = 'news-pulse-test';
  let update = null;
  PushRegistration.updateOne = async (_filter, value) => { update = value; return { modifiedCount: 1 }; };
  firebaseAdmin.setFirebaseAdminModulesForTests({
    appModule: {
      getApps: () => [{ options: { projectId: 'news-pulse-test' } }],
      cert: () => ({}),
      applicationDefault: () => ({}),
      initializeApp: () => { throw new Error('should not initialize'); },
    },
    messagingModule: {
      getMessaging: () => ({
        send: async () => {
          const error = new Error('temporary outage');
          error.code = 'messaging/internal-error';
          throw error;
        },
      }),
    },
  });

  const result = await pushMessagingService.sendPushToRegistration({
    _id: 'push-1',
    registrationId: 'fcm-token-temp:defghijklmnopqrstuvwxyz0123456789',
    registrationType: 'token',
    enabled: true,
    status: 'active',
  }, { title: 'News Pulse', body: 'Works', url: 'https://www.newspulse.co.in/news/test' });

  assert.equal(result.success, false);
  assert.equal(result.permanent, false);
  assert.equal(Object.prototype.hasOwnProperty.call(update.$set, 'enabled'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(update.$set, 'status'), false);
});