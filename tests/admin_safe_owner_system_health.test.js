const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

const EXPECTED_SECTIONS = [
  'backendApi',
  'mongodb',
  'redis',
  'translationWorker',
  'smtpEmail',
  'environment',
];

const SECRET_FIELD_PATTERN = /(secret|password|pass|token|key|uri|user|host|smtpUser|smtpPass|redisUrl)/i;

function assertNoSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(SECRET_FIELD_PATTERN.test(key), false, `secret-like field leaked: ${key}`);
    assertNoSecretFields(nested);
  }
}

test('GET /api/admin/safe-owner-zone/system-health requires admin auth', async () => {
  const res = await request(app).get('/api/admin/safe-owner-zone/system-health');

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test('GET /api/admin/safe-owner-zone/system-health returns safe read-only status shape', async () => {
  const res = await request(app)
    .get('/api/admin/safe-owner-zone/system-health')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.data.checkedAt, 'string');
  assert.ok(!Number.isNaN(new Date(res.body.data.checkedAt).getTime()));

  for (const section of EXPECTED_SECTIONS) {
    assert.equal(typeof res.body.data[section], 'object', `${section} missing`);
    assert.equal(typeof res.body.data[section].status, 'string', `${section}.status missing`);
    assert.equal(typeof res.body.data[section].message, 'string', `${section}.message missing`);
  }

  assert.ok(['ok', 'error'].includes(res.body.data.backendApi.status));
  assert.ok(['ok', 'error', 'unknown'].includes(res.body.data.mongodb.status));
  assert.ok(['connected', 'not_configured', 'error', 'unknown'].includes(res.body.data.redis.status));
  assert.ok(['running', 'stopped', 'unknown'].includes(res.body.data.translationWorker.status));
  assert.ok(['configured', 'missing', 'unknown'].includes(res.body.data.smtpEmail.status));
  assert.ok(['ok', 'check_needed'].includes(res.body.data.environment.status));

  assertNoSecretFields(res.body.data);
});
