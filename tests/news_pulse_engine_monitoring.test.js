const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const NewsPulseIncident = require('../models/NewsPulseIncident');
const SystemSetting = require('../models/SystemSetting');
const User = require('../models/User');
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
  const prevFindByIdAndUpdate = NewsPulseIncident.findByIdAndUpdate;
  const prevSystemFindOneAndUpdate = SystemSetting.findOneAndUpdate;

  const docs = [];
  const latestWrites = [];
  let seq = 0;
  let duplicateRaceTriggered = false;

  t.after(() => {
    NewsPulseIncident.findOne = prevFindOne;
    NewsPulseIncident.find = prevFind;
    NewsPulseIncident.create = prevCreate;
    NewsPulseIncident.findByIdAndUpdate = prevFindByIdAndUpdate;
    SystemSetting.findOneAndUpdate = prevSystemFindOneAndUpdate;
    monitoring.stopNewsPulseEngineMonitoring();
  });

  NewsPulseIncident.findOne = (filter = {}) => createQueryResult(docs.find((doc) => {
    if (filter.checkId !== undefined && doc.checkId !== filter.checkId) return false;
    if (filter.state !== undefined && doc.state !== filter.state) return false;
    return true;
  }) || null);

  NewsPulseIncident.find = (filter = {}) => createQueryResult(docs.filter((doc) => {
    if (filter.state !== undefined && doc.state !== filter.state) return false;
    return true;
  }).map((doc) => ({ ...doc })));

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

  SystemSetting.findOneAndUpdate = async (_filter, update) => {
    latestWrites.push(update.$set.value);
    return { key: monitoring.LATEST_STATE_KEY, value: update.$set.value };
  };

  return { docs, latestWrites };
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

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy')]), { now: new Date('2026-08-31T00:00:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention')]), { now: new Date('2026-08-31T00:01:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].state, 'open');
  assert.equal(store.docs[0].status, 'attention');
  assert.equal(store.docs[0].expiresAt, null);

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention', { message: 'still degraded' })]), { now: new Date('2026-08-31T00:02:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].message, 'still degraded');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical')]), { now: new Date('2026-08-31T00:03:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].status, 'critical');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'attention')]), { now: new Date('2026-08-31T00:04:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].status, 'attention');
  assert.equal(store.docs[0].state, 'open');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'healthy')]), { now: new Date('2026-08-31T00:10:00.000Z') });
  assert.equal(store.docs.length, 1);
  assert.equal(store.docs[0].state, 'resolved');
  assert.equal(store.docs[0].resolvedAt.toISOString(), '2026-08-31T00:10:00.000Z');
  assert.equal(store.docs[0].durationMs, 9 * 60 * 1000);
  assert.equal(store.docs[0].expiresAt.toISOString(), '2026-09-30T00:10:00.000Z');

  await monitoring.recordHealthSnapshot(snapshot([check('public-website', 'critical')]), { now: new Date('2026-08-31T00:20:00.000Z') });
  assert.equal(store.docs.length, 2);
  assert.equal(store.docs[1].state, 'open');
  assert.equal(store.docs[1].expiresAt, null);
});

test('monitoring repeated critical checks keep one open incident', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  await monitoring.recordHealthSnapshot(snapshot([check('database', 'healthy')]), { now: new Date('2026-08-31T00:00:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot([check('database', 'critical', { message: 'Database connection is not ready.' })]), { now: new Date('2026-08-31T00:05:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot([check('database', 'critical', { message: 'Database connection is still not ready.' })]), { now: new Date('2026-08-31T00:10:00.000Z') });

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

test('monitoring handles duplicate-key create races by updating the existing open incident', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t, { duplicateCreateRaceForCheckId: 'public-website' });

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical', {
      message: 'Homepage failed from the losing process.',
      recommendation: 'Inspect the active production incident.',
    }),
  ]), { now: new Date('2026-08-31T01:30:00.000Z') });

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

test('monitoring skips known configuration-only analytics and admin panel states', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t);

  const checks = [
    check('analytics', 'attention', { message: 'Analytics integration is not configured or could not be confirmed.' }),
    check('admin-panel', 'unknown', { message: 'Admin Panel external availability is not configured for backend diagnostics.' }),
  ];
  await monitoring.recordHealthSnapshot(snapshot(checks), { now: new Date('2026-08-31T01:00:00.000Z') });
  await monitoring.recordHealthSnapshot(snapshot(checks), { now: new Date('2026-08-31T01:05:00.000Z') });

  assert.equal(store.docs.length, 0);
});

test('monitoring continues processing checks when one incident write fails', async (t) => {
  stubDbReady(t);
  const store = installIncidentStore(t, { failCreateForCheckId: 'public-website' });

  const result = await monitoring.recordHealthSnapshot(snapshot([
    check('public-website', 'critical'),
    check('seo', 'critical'),
  ]), { now: new Date('2026-08-31T02:00:00.000Z') });

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

  stubAdminUser(t, 'admin');
  const adminRes = await request(app)
    .get('/api/admin/news-pulse-engine/incidents')
    .set('Authorization', `Bearer ${signAdminToken('admin')}`);
  assert.equal(adminRes.status, 403);

  stubAdminUser(t, 'manager');
  const managerStatusRes = await request(app)
    .get('/api/admin/news-pulse-engine/monitoring/status')
    .set('Authorization', `Bearer ${signAdminToken('manager')}`);
  assert.equal(managerStatusRes.status, 403);

  const unauthenticatedRes = await request(app).get('/api/admin/news-pulse-engine/incidents');
  assert.equal(unauthenticatedRes.status, 401);
});