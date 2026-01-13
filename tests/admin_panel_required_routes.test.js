const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('GET /api/system/health returns 200 with expected shape', async () => {
  const res = await request(app).get('/api/system/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'newspulse-backend');
  assert.ok(typeof res.body.time === 'string');
  assert.ok(typeof res.body.env === 'string');
});

test('GET /api/api/system/health is normalized (no 404)', async () => {
  const res = await request(app).get('/api/api/system/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'newspulse-backend');
});

test('GET /api/system/ai-health returns 200 (no 404) with AI disabled stub', async () => {
  const res = await request(app).get('/api/system/ai-health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.aiEnabled, false);
  assert.equal(res.body.message, 'AI command not configured');
});

test('GET /admin-api/system/health returns 200 JSON (no DB dependency)', async () => {
  const res = await request(app).get('/admin-api/system/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(typeof res.body.time === 'string');
  assert.ok(typeof res.body.uptimeSeconds === 'number');
});

test('GET /admin-api/admin/system/ai-training-info returns 200 JSON when AI not configured', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/admin-api/admin/system/ai-training-info')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.message, 'AI not configured');
  assert.ok(String(res.headers['content-type'] || '').includes('application/json'));
});

test('GET /admin-api/admin/ads returns 503 JSON when DB unavailable', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/admin-api/admin/ads')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.ok(String(res.headers['content-type'] || '').includes('application/json'));
});

test('GET /api/broadcast/settings returns 200 for admin', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/api/broadcast/settings')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'breakingEnabled'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'liveEnabled'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'breakingMode'));
  assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'liveMode'));
});

test('GET /api/broadcast/items?type=live returns 200 for admin', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/api/broadcast/items?type=live')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/audit/recent is mounted (401 when unauthenticated)', async () => {
  const res = await request(app).get('/api/audit/recent?limit=1');
  assert.equal(res.status, 401);
});

test('GET /api/admin/system/snapshots is mounted (401 when unauthenticated)', async () => {
  const res = await request(app).get('/api/admin/system/snapshots?limit=1');
  assert.equal(res.status, 401);
});
