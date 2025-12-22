const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

// Use legacy cookie auth as founder (adminAuth treats FOUNDER_EMAIL as founder).
const founderEmail = String(process.env.FOUNDER_EMAIL || 'founder@example.com').toLowerCase();
const founderCookie = `np_admin=${founderEmail}`;

test('GET /api/admin/staff without auth returns 401', async () => {
  await request(app)
    .get('/api/admin/staff')
    .expect(401);
});

test('GET /api/admin/staff with founder cookie returns success shape', async () => {
  const res = await request(app)
    .get('/api/admin/staff')
    .set('Cookie', founderCookie)
    .expect(200);

  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data));
});

test('GET /api/admin/team without auth returns 401 (alias)', async () => {
  const res = await request(app).get('/api/admin/team');
  assert.equal(res.status, 401);
});
