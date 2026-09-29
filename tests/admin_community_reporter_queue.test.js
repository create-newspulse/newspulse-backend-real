const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
test.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
const app = require('../server');

const signedCookie = 'np_admin_token=' + require('jsonwebtoken').sign({ role: 'founder', type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m' });

test('GET /api/admin/community-reporter/queue without auth returns 401', async () => {
  const res = await request(app).get('/api/admin/community-reporter/queue?status=pending');
  assert.equal(res.status, 401);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok === false);
});

test('GET /api/admin/community-reporter/queue with signed Founder cookie returns 200 JSON', async () => {
  const res = await request(app)
    .get('/api/admin/community-reporter/queue?status=pending')
    .set('Cookie', signedCookie);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body.ok === true);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.meta && typeof res.body.meta === 'object');
});
