const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('GET /api/admin/me returns 200 even when unauthenticated', async () => {
  const res = await request(app).get('/api/admin/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.authenticated, false);
});

test('GET /api/admin/me returns authenticated:true when cookie is present', async () => {
  const res = await request(app)
    .get('/api/admin/me')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.authenticated, true);
  assert.ok(res.body.admin);
});
