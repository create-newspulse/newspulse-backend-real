const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const NewsPulseAlert = require('../models/NewsPulseAlert');
const NewsPulseIncident = require('../models/NewsPulseIncident');
const SystemSetting = require('../models/SystemSetting');
const User = require('../models/User');
const alertService = require('../services/newsPulseEngineAlertService');
const monitoring = require('../services/newsPulseEngineMonitoringService');

const STAFF_EMAIL = 'staff@newspulse.ai';

function signAdminToken(role) {
  return jwt.sign(
    { sub: 'staff-id', email: STAFF_EMAIL, role },
    process.env.JWT_SECRET || 'dev-secret-change-me',
  );
}

function stubDbReady(t, ready = true) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = ready ? 1 : 0;
}

function stubAdminUser(t, role) {
  const prevFindOne = User.findOne;
  t.after(() => { User.findOne = prevFindOne; });
  User.findOne = () => ({
    lean: async () => ({ email: STAFF_EMAIL, role, isFounder: role === 'founder', status: 'active' }),
  });
}

function createQueryResult(value) {
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    lean: async () => value,
  };
  return chain;
}

function installIncidentStore(t, { failCreateForCheckId = null, duplicateCreateRaceForCheckId = null } = {}) {
  const prevFindOne = NewsPulseIncident.findOne;
  const prevFind = NewsPulseIncident.find;
  const prevCreate = NewsPulseIncident.create;
  const prevFindOneAndUpdate = NewsPulseIncident.findOneAndUpdate;
  const prevFindByIdAndUpdate = NewsPulseIncident.findByIdAndUpdate;
  const prevAlertFindOne = NewsPulseAlert.findOne;
  const prevAlertFind = NewsPulseAlert.find;
  const prevAlertCreate = NewsPulseAlert.create;
  const prevAlertFindByIdAndUpdate = NewsPulseAlert.findByIdAndUpdate;
  const prevSystemFindOneAndUpdate = SystemSetting.findOneAndUpdate;

  const docs = [];
  const alerts = [];
  const latestWrites = [];
  let seq = 0;
  let alertSeq = 0;
  let duplicateRaceTriggered = false;

  t.after(() => {
    NewsPulseIncident.findOne = prevFindOne;
    NewsPulseIncident.find = prevFind;
    NewsPulseIncident.create = prevCreate;
    NewsPulseIncident.findOneAndUpdate = prevFindOneAndUpdate;
    NewsPulseIncident.findByIdAndUpdate = prevFindByIdAndUpdate;
    NewsPulseAlert.findOne = prevAlertFindOne;
    NewsPulseAlert.find = prevAlertFind;
    NewsPulseAlert.create = prevAlertCreate;
    NewsPulseAlert.findByIdAndUpdate = prevAlertFindByIdAndUpdate;
    SystemSetting.findOneAndUpdate = prevSystemFindOneAndUpdate;
    monitoring.stopNewsPulseEngineMonitoring();
  });

  function matchesFilter(doc, filter = {}) {
    return Object.entries(filter || {}).every(([key, expected]) => {
      const actual = doc[key];
      if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
        if (Object.prototype.hasOwnProperty.call(expected, '$ne')) return actual !== expected.$ne;
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) return expected.$exists ? actual !== undefined : actual === undefined;
        return false;
      }
      if (expected === null) return actual === null || actual === undefined;
      return String(actual) === String(expected);
    });
  }

  NewsPulseIncident.findOne = (filter = {}) => createQueryResult(docs.find((doc) => matchesFilter(doc, filter)) || null);

  NewsPulseIncident.find = (filter = {}) => createQueryResult(docs.filter((doc) => matchesFilter(doc, filter)).map((doc) => ({ ...doc })));

  NewsPulseIncident.create = async (payload) => {
    if (duplicateCreateRaceForCheckId && payload.checkId === duplicateCreateRaceForCheckId && !duplicateRaceTriggered) {
      duplicateRaceTriggered = true;
      docs.push({
        _id: `incident-${++seq}`,
        createdAt: new Date(payload.startedAt || Date.now()),
        updatedAt: new Date(payload.startedAt || Date.now()),
        ...payload,
      });
      const error = new Error('E11000 duplicate key error collection: news_pulse_incidents index: uniq_open_news_pulse_incident_per_check dup key');
      error.code = 11000;
      throw error;
    }
    if (failCreateForCheckId && payload.checkId === failCreateForCheckId) {
      throw new Error('simulated create failure');
    }
    const doc = {
      _id: `incident-${++seq}`,
      createdAt: new Date(payload.startedAt || Date.now()),
      updatedAt: new Date(payload.startedAt || Date.now()),
      ...payload,
    };
    docs.push(doc);
    return doc;
  };

  NewsPulseIncident.findOneAndUpdate = async (filter, update) => {
    const doc = docs.find((entry) => matchesFilter(entry, filter));
    if (!doc) return null;
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) delete doc[key];
    }
    doc.updatedAt = new Date();
    return doc;
  };

  NewsPulseIncident.findByIdAndUpdate = async (id, update) => {
    const doc = docs.find((entry) => String(entry._id) === String(id));
    if (!doc) return null;
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) delete doc[key];
    }
    doc.updatedAt = new Date();
    return doc;
  };

  NewsPulseAlert.findOne = (filter = {}) => createQueryResult(alerts.find((doc) => matchesFilter(doc, filter)) || null);

  NewsPulseAlert.find = (filter = {}) => createQueryResult(alerts.filter((doc) => matchesFilter(doc, filter)).map((doc) => ({ ...doc })));

  NewsPulseAlert.create = async (payload) => {
    if (alerts.some((entry) => entry.incidentId === String(payload.incidentId) && entry.type === payload.type)) {
      const error = new Error('E11000 duplicate key error collection: news_pulse_alerts index: uniq_news_pulse_alert_per_incident_type dup key');
      error.code = 11000;
      throw error;
    }
    const doc = {
      _id: `alert-${++alertSeq}`,
      createdAt: new Date(payload.claimedAt || Date.now()),
      updatedAt: new Date(payload.claimedAt || Date.now()),
      ...payload,
    };
    alerts.push(doc);
    return doc;
  };

  NewsPulseAlert.findByIdAndUpdate = async (id, update) => {
    const doc = alerts.find((entry) => String(entry._id) === String(id));
    if (!doc) return null;
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) delete doc[key];
    }
    doc.updatedAt = new Date();
    return doc;
  };

  SystemSetting.findOneAndUpdate = async (_filter, update) => {
    latestWrites.push(update.$set.value);
    return { key: monitoring.LATEST_STATE_KEY, value: update.$set.value };
  };

  return { docs, alerts, latestWrites };
}

function check(id, status, overrides = {}) {
  return {
    id,
    area: overrides.area || id,
    status,
    message: overrides.message || `${id} ${status}`,
    recommendation: overrides.recommendation || '',
    checkedAt: overrides.checkedAt || new Date().toISOString(),
  };
}

function snapshot(checks) {
  return { ok: true, checkedAt: new Date().toISOString(), overallStatus: 'attention', summary: {}, checks };
}

async function testFounderAlertDelivery() {
  return { provider: 'test-mail' };
}

test('monitoring healthy baseline records latest state without opening incidents', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('backend-api', 'healthy'),
    check('public-website', 'healthy'),
  ]), { now: new Date('2026-08-31T00:00:00.000Z') });

  assert.equal(result.ok, true);
  assert.equal(store.docs.length, 0);
  assert.equal(store.latestWrites.length, 1);
  assert.equal(store.latestWrites[0].checks['public-website'].status, 'healthy');
});

test('monitoring incident lifecycle dedupes, changes severity, resolves, and creates recurrence', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy')]), { now: new Date('2026-08-31T00:00:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention')]), { now: new Date('2026-08-31T00:01:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].state, 'open');
  assert.equal(store.docs[0].status, 'attention');
  assert.equal(store.docs[0].expiresAt, null);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention', { message: 'still degraded' })]), { now: new Date('2026-08-31T00:02:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].message, 'still degraded');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical')]), { now: new Date('2026-08-31T00:03:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].status, 'critical');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention')]), { now: new Date('2026-08-31T00:04:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].status, 'attention');
  assert.equal(store.docs[0].state, 'open');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy')]), { now: new Date('2026-08-31T00:10:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].state, 'resolved');
  assert.equal(store.docs[0].resolvedAt.toISOString(), '2026-08-31T00:10:00.000Z');
  assert.equal(store.docs[0].durationMs, 9 * 60 * 1000);
  assert.equal(store.docs[0].expiresAt.toISOString(), '2026-09-30T00:10:00.000Z');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical')]), { now: new Date('2026-08-31T00:20:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  assert.equal(store.docs.length, 2);
  assert.equal(store.docs[1].state, 'open');
  assert.equal(store.docs[1].expiresAt, null);
});

test('monitoring repeated critical checks keep one open incident', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  await monitoring.recordHealthSnapshot(snapshot([check('database', 'healthy')]), { now: new Date('2026-08-31T00:00:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  await monitoring.recordHealthSnapshot(snapshot([check('database', 'critical', { message: 'Database connection is not ready.' })]), { now: new Date('2026-08-31T00:05:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });
  await monitoring.recordHealthSnapshot(snapshot([check('database', 'critical', { message: 'Database connection is still not ready.' })]), { now: new Date('2026-08-31T00:10:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });

  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].state, 'open');
  assert.equal(store.docs[0].status, 'critical');
  assert.equal(store.docs[0].message, 'Database connection is still not ready.');
  assert.equal(store.docs[0].lastSeenAt.toISOString(), '2026-08-31T00:10:00.000Z');
});

test('incident model uses expiresAt TTL for resolved history retention', () => {
  const ttlIndex = NewsPulseIncident.schema.indexes().find(([fields, options]) => (
    fields && fields.expiresAt === 1 && options && options.expireAfterSeconds === 0
  ));

  assert.ok(ttlIndex);
});

test('incident model uniquely indexes open incidents by checkId without constraining resolved history', () => {
  const uniqueOpenIndex = NewsPulseIncident.schema.indexes().find(([fields, options]) => (
    fields
    && Object.keys(fields).length === 1
    && fields.checkId === 1
    && options
    && options.unique === true
    && options.partialFilterExpression
    && options.partialFilterExpression.state === 'open'
  ));

  assert.ok(uniqueOpenIndex);
  assert.equal(uniqueOpenIndex[1].name, 'uniq_open_news_pulse_incident_per_check');
});

test('alert model retains recent history and dedupes one alert per incident type', () => {
  const uniqueAlertIndex = NewsPulseAlert.schema.indexes().find(([fields, options]) => (
    fields
    && fields.incidentId === 1
    && fields.type === 1
    && options
    && options.unique === true
  ));
  const ttlIndex = NewsPulseAlert.schema.indexes().find(([fields, options]) => (
    fields && fields.expiresAt === 1 && options && options.expireAfterSeconds === 0
  ));

  assert.ok(uniqueAlertIndex);
  assert.equal(uniqueAlertIndex[1].name, 'uniq_news_pulse_alert_per_incident_type');
  assert.ok(ttlIndex);
});

test('monitoring handles duplicate-key create races by updating the existing open incident', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t, { duplicateCreateRaceForCheckId: 'public-website' });

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical', {
      message: 'Homepage failed from the losing process.',
      recommendation: 'Inspect the active production incident.',
    }),
  ]), { now: new Date('2026-08-31T01:30:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });

  assert.equal(result.ok, true);
  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].action, 'updated');
  assert.equal(result.processed[0].reason, 'duplicate_open_race');
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].checkId, 'public-website');
  assert.equal(store.docs[0].state, 'open');
  assert.equal(store.docs[0].message, 'Homepage failed from the losing process.');
  assert.equal(store.docs[0].lastSeenAt.toISOString(), '2026-08-31T01:30:00.000Z');
});

test('monitoring sends one critical alert and one recovery alert per critical incident lifecycle', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);
  const deliveries = [];
  const options = {
    deliverFounderAlert: async (alert) => {
      deliveries.push({ type: alert.type, area: alert.area, message: alert.message });
      return { provider: 'test-mail' };
    },
  };

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy', { area: 'Public Website' })]), { ...options, now: new Date('2026-08-31T04:00:00.000Z') });
  assert.equal(store.alerts.length, 0);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention', { area: 'Public Website' })]), { ...options, now: new Date('2026-08-31T04:05:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.alerts.length, 0);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical', {
    area: 'Public Website',
    message: 'Homepage returned 500.',
    recommendation: 'Check the public deployment.',
  })]), { ...options, now: new Date('2026-08-31T04:10:00.000Z') });
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].type, 'critical');
  assert.equal(store.alerts[0].title, 'News Pulse Critical Alert');
  assert.equal(store.alerts[0].message, 'Public Website has entered a critical state.');
  assert.equal(store.alerts[0].incidentMessage, 'Homepage returned 500.');
  assert.equal(store.alerts[0].deliveryStatus, 'sent');
  assert.equal(deliveries.length, 1);
  assert.ok(store.docs[0].criticalAlertClaimedAt);
  assert.ok(store.docs[0].criticalAlertSentAt);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical', { area: 'Public Website', message: 'Still failing.' })]), { ...options, now: new Date('2026-08-31T04:15:00.000Z') });
  assert.equal(store.alerts.length, 1);
  assert.equal(deliveries.length, 1);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention', { area: 'Public Website', message: 'Partially degraded.' })]), { ...options, now: new Date('2026-08-31T04:20:00.000Z') });
  assert.equal(store.alerts.length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(store.docs[0].state, 'open');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy', { area: 'Public Website' })]), { ...options, now: new Date('2026-08-31T04:30:00.000Z') });
  assert.equal(store.alerts.length, 2);
  assert.equal(store.alerts[1].type, 'recovery');
  assert.equal(store.alerts[1].title, 'News Pulse Recovered');
  assert.equal(store.alerts[1].message, 'Public Website has recovered.');
  assert.equal(store.alerts[1].deliveryStatus, 'sent');
  assert.equal(deliveries.length, 2);
  assert.ok(store.docs[0].recoveryAlertClaimedAt);
  assert.ok(store.docs[0].recoveryAlertSentAt);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy', { area: 'Public Website' })]), { ...options, now: new Date('2026-08-31T04:35:00.000Z') });
  assert.equal(store.alerts.length, 2);
  assert.equal(deliveries.length, 2);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical', { area: 'Public Website', message: 'New outage.' })]), { ...options, now: new Date('2026-08-31T05:00:00.000Z') });
  assert.equal(store.docs.length, 2);
  assert.equal(store.alerts.length, 3);
  assert.equal(store.alerts[2].type, 'critical');
  assert.equal(store.alerts[2].incidentMessage, 'New outage.');
  assert.equal(deliveries.length, 3);
});

test('persisted alert claims prevent resending after restart or a new monitoring process', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);
  const deliveries = [];
  store.docs.push({
    _id: 'incident-claimed-critical',
    checkId: 'database',
    area: 'Database',
    status: 'critical',
    state: 'open',
    message: 'Database unavailable.',
    recommendation: 'Inspect database connectivity.',
    startedAt: new Date('2026-08-31T06:00:00.000Z'),
    lastSeenAt: new Date('2026-08-31T06:00:00.000Z'),
    resolvedAt: null,
    durationMs: null,
    expiresAt: null,
    criticalAlertClaimedAt: new Date('2026-08-31T06:00:01.000Z'),
  });

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('database', 'critical', { area: 'Database', message: 'Database still unavailable.' }),
  ]), {
    now: new Date('2026-08-31T06:05:00.000Z'),
    deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; },
  });

  assert.equal(result.ok, true);
  assert.equal(store.alerts.length, 0);
  assert.equal(deliveries.length, 0);
});

test('attention to critical sends exactly one critical alert without requiring a new incident', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);
  const deliveries = [];
  const options = {
    deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; },
  };

  await monitoring.recordHealthSnapshot(snapshot([check('seo', 'attention', { area: 'SEO' })]), { ...options, now: new Date('2026-08-31T06:30:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot([check('seo', 'critical', { area: 'SEO', message: 'Sitemap unavailable.' })]), { ...options, now: new Date('2026-08-31T06:35:00.000Z') });

  assert.equal(store.docs.length, 1);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].type, 'critical');
  assert.equal(store.alerts[0].incidentId, 'incident-1');
  assert.equal(deliveries.length, 1);
});

test('configuration-only states and non-critical attention do not create founder alerts', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  const checks = [
    check('analytics', 'attention', { message: 'News Pulse analytics is enabled, but recent activity could not be confirmed.' }),
    check('admin-panel', 'unknown', { message: 'Admin Panel external availability is not configured for backend diagnostics.' }),
    check('seo', 'attention', { area: 'SEO', message: 'Sitemap could not be confirmed.' }),
  ];
  const result = await monitoring.recordHealthSnapshot(snapshot(checks), {
    now: new Date('2026-08-31T06:45:00.000Z'),
    deliverFounderAlert: async () => { throw new Error('should not deliver'); },
  });

  assert.equal(result.ok, true);
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].checkId, 'seo');
  assert.equal(store.alerts.length, 0);
});

test('concurrent critical alert claims only deliver once', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);
  const deliveries = [];
  const incident = {
    _id: 'incident-concurrent-critical',
    checkId: 'public-website',
    area: 'Public Website',
    status: 'critical',
    state: 'open',
    message: 'Homepage unavailable.',
    recommendation: 'Check public deployment.',
    startedAt: new Date('2026-08-31T07:00:00.000Z'),
    lastSeenAt: new Date('2026-08-31T07:00:00.000Z'),
    resolvedAt: null,
    durationMs: null,
    expiresAt: null,
  };
  store.docs.push(incident);

  await Promise.all([
    alertService.createFounderIncidentAlert('critical', incident, { now: new Date('2026-08-31T07:00:01.000Z'), deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; } }),
    alertService.createFounderIncidentAlert('critical', incident, { now: new Date('2026-08-31T07:00:01.000Z'), deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; } }),
  ]);

  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].type, 'critical');
  assert.equal(deliveries.length, 1);
});

test('concurrent recovery alert claims only deliver once', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);
  const deliveries = [];
  const incident = {
    _id: 'incident-concurrent-recovery',
    checkId: 'public-website',
    area: 'Public Website',
    status: 'critical',
    state: 'resolved',
    message: 'Homepage was unavailable.',
    recommendation: 'Review deployment logs.',
    startedAt: new Date('2026-08-31T07:30:00.000Z'),
    lastSeenAt: new Date('2026-08-31T07:40:00.000Z'),
    resolvedAt: new Date('2026-08-31T07:40:00.000Z'),
    durationMs: 10 * 60 * 1000,
    expiresAt: new Date('2026-09-30T07:40:00.000Z'),
    criticalAlertClaimedAt: new Date('2026-08-31T07:30:01.000Z'),
    criticalAlertSentAt: new Date('2026-08-31T07:30:01.000Z'),
  };
  store.docs.push(incident);
  store.alerts.push({
    _id: 'alert-existing-critical',
    incidentId: 'incident-concurrent-recovery',
    checkId: 'public-website',
    type: 'critical',
    title: 'News Pulse Critical Alert',
    area: 'Public Website',
    message: 'Public Website has entered a critical state.',
    startedAt: incident.startedAt,
    deliveryStatus: 'sent',
    claimedAt: new Date('2026-08-31T07:30:01.000Z'),
    expiresAt: new Date('2026-09-30T07:30:01.000Z'),
    createdAt: new Date('2026-08-31T07:30:01.000Z'),
  });

  await Promise.all([
    alertService.createFounderIncidentAlert('recovery', incident, { now: new Date('2026-08-31T07:40:01.000Z'), deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; } }),
    alertService.createFounderIncidentAlert('recovery', incident, { now: new Date('2026-08-31T07:40:01.000Z'), deliverFounderAlert: async (alert) => { deliveries.push(alert); return { provider: 'test-mail' }; } }),
  ]);

  assert.equal(store.alerts.length, 2);
  assert.equal(store.alerts.filter((alert) => alert.type === 'recovery').length, 1);
  assert.equal(deliveries.length, 1);
});

test('founder alert delivery failure is recorded safely without stopping monitoring', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical', { area: 'Public Website', message: 'Homepage unavailable.' }),
  ]), {
    now: new Date('2026-08-31T08:00:00.000Z'),
    deliverFounderAlert: async () => { throw new Error('secret smtp token leaked in provider message'); },
  });

  assert.equal(result.ok, true);
  assert.equal(store.docs.length, 1);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].deliveryStatus, 'failed');
  assert.equal(store.alerts[0].deliveryErrorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(JSON.stringify(store.alerts[0]).includes('secret smtp token'), false);

  await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical', { area: 'Public Website', message: 'Still unavailable.' }),
  ]), {
    now: new Date('2026-08-31T08:05:00.000Z'),
    deliverFounderAlert: async () => { throw new Error('should not retry immediately'); },
  });
  assert.equal(store.alerts.length, 1);
});

test('monitoring skips known first-party analytics attention and admin panel states', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  const checks = [
    check('analytics', 'attention', { message: 'News Pulse analytics is enabled, but recent activity could not be confirmed.' }),
    check('admin-panel', 'unknown', { message: 'Admin Panel external availability is not configured for backend diagnostics.' }),
  ];
  await monitoring.recordHealthSnapshot(snapshot(checks), { now: new Date('2026-08-31T01:00:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot(checks), { now: new Date('2026-08-31T01:05:00.000Z') });

  assert.equal(store.docs.length, 0);
  assert.equal(store.alerts.length, 0);
});

test('monitoring continues processing checks when one incident write fails', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t, { failCreateForCheckId: 'public-website' });

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical'),
    check('seo', 'critical'),
  ]), { now: new Date('2026-08-31T02:00:00.000Z'), deliverFounderAlert: testFounderAlertDelivery });

  assert.equal(result.ok, true);
  assert.equal(result.processed.some((entry) => entry.action === 'error' && entry.checkId === 'public-website'), true);
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].checkId, 'seo');
});

test('monitoring scheduler is disabled in tests, registers once in production, and handles run errors', async (t) => {
  t.after(() => monitoring.stopNewsPulseEngineMonitoring());

  const disabled = monitoring.startNewsPulseEngineMonitoring({ env: { NODE_ENV: 'test' }, runImmediately: false });
  assert.equal(disabled.started, false);
  assert.equal(disabled.reason, 'disabled');

  const started = monitoring.startNewsPulseEngineMonitoring({ env: { NODE_ENV: 'production' }, runImmediately: false, intervalMs: 60 * 1000 });
  assert.equal(started.started, true);

  const duplicate = monitoring.startNewsPulseEngineMonitoring({ env: { NODE_ENV: 'production' }, runImmediately: false, intervalMs: 60 * 1000 });
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'already_started');

  const failed = await monitoring.runMonitoringOnce({ healthService: async () => { throw new Error('health failed'); }, logger: { warn() {} } });
  assert.equal(failed.ok, false);
});

test('Founder-only incident and monitoring status endpoints enforce Engine authorization', async (t) => {
  stubDbReady(t);
  stubAdminUser(t, 'founder');
  const store = installIncidentStore(t);
  store.docs.push({
    _id: 'incident-1',
    checkId: 'public-website',
    area: 'Public Website',
    status: 'critical',
    state: 'open',
    message: 'Homepage could not be reached.',
    recommendation: 'Check deployment.',
    startedAt: new Date('2026-08-31T03:00:00.000Z'),
    lastSeenAt: new Date('2026-08-31T03:05:00.000Z'),
    resolvedAt: null,
    durationMs: null,
  });
  store.alerts.push({
    _id: 'alert-1',
    incidentId: 'incident-1',
    checkId: 'public-website',
    type: 'critical',
    title: 'News Pulse Critical Alert',
    area: 'Public Website',
    message: 'Public Website has entered a critical state.',
    incidentMessage: 'Homepage could not be reached.',
    recommendation: 'Check deployment.',
    startedAt: new Date('2026-08-31T03:00:00.000Z'),
    resolvedAt: null,
    durationMs: null,
    deliveryStatus: 'sent',
    deliveryProvider: 'test-mail',
    sentAt: new Date('2026-08-31T03:00:01.000Z'),
    deliveryErrorCode: null,
    claimedAt: new Date('2026-08-31T03:00:01.000Z'),
    expiresAt: new Date('2026-09-30T03:00:01.000Z'),
    createdAt: new Date('2026-08-31T03:00:01.000Z'),
  });

  const founderToken = signAdminToken('founder');
  const founderRes = await request(app)
    .get('/api/admin/news-pulse-engine/incidents?status=open')
    .set('Authorization', `Bearer ${founderToken}`);

  assert.equal(founderRes.status, 200);
  assert.equal(founderRes.body.ok, true);
  assert.equal(founderRes.body.incidents.length, 1);
  assert.equal(founderRes.body.incidents[0].id, 'incident-1');

  const statusRes = await request(app)
    .get('/api/admin/news-pulse-engine/monitoring/status')
    .set('Authorization', `Bearer ${founderToken}`);
  assert.equal(statusRes.status, 200);
  assert.equal(typeof statusRes.body.data.enabled, 'boolean');

  const alertsRes = await request(app)
    .get('/api/admin/news-pulse-engine/alerts')
    .set('Authorization', `Bearer ${founderToken}`);
  assert.equal(alertsRes.status, 200);
  assert.equal(alertsRes.body.ok, true);
  assert.equal(alertsRes.body.alerts.length, 1);
  assert.equal(alertsRes.body.alerts[0].id, 'alert-1');
  assert.equal(alertsRes.body.alerts[0].deliveryStatus, 'sent');

  stubAdminUser(t, 'admin');
  const adminRes = await request(app)
    .get('/api/admin/news-pulse-engine/incidents')
    .set('Authorization', `Bearer ${signAdminToken('admin')}`);
  assert.equal(adminRes.status, 403);

  const adminAlertsRes = await request(app)
    .get('/api/admin/news-pulse-engine/alerts')
    .set('Authorization', `Bearer ${signAdminToken('admin')}`);
  assert.equal(adminAlertsRes.status, 403);

  stubAdminUser(t, 'manager');
  const managerStatusRes = await request(app)
    .get('/api/admin/news-pulse-engine/monitoring/status')
    .set('Authorization', `Bearer ${signAdminToken('manager')}`);
  assert.equal(managerStatusRes.status, 403);

  const unauthenticatedRes = await request(app).get('/api/admin/news-pulse-engine/incidents');
  assert.equal(unauthenticatedRes.status, 401);

  const unauthenticatedAlertsRes = await request(app).get('/api/admin/news-pulse-engine/alerts');
  assert.equal(unauthenticatedAlertsRes.status, 401);
});