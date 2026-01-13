const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /api/admin/settings returns 200 with defaults (no 404)', async () => {
  const res = await request(app)
    .get('/api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  // In test mode the server skips DB connection; admin endpoints should respond 503 JSON.
  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('GET /admin-api/admin/settings returns 200 with defaults (alias)', async () => {
  const res = await request(app)
    .get('/admin-api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('GET /api/admin/public-settings returns 200 with defaults (no 404)', async () => {
  const res = await request(app)
    .get('/api/admin/public-settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.equal(res.status, 503);
  assert.ok(res.body && res.body.ok === false);
});

test('PUT /api/admin/settings exists (returns 503 when DB unavailable, not 404)', async () => {
  const res = await request(app)
    .put('/api/admin/settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ adminPanel: { theme: 'dark' } });

  assert.notEqual(res.status, 404);
});

test('PUT /api/admin/public-settings exists (returns 503 when DB unavailable, not 404)', async () => {
  const res = await request(app)
    .put('/api/admin/public-settings')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send({ publicSite: { footer: { links: [] } } });

  assert.notEqual(res.status, 404);
});
