const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Admin Broadcast endpoints under /admin-api return JSON (401 when unauthenticated)', async () => {
  const paths = [
    '/admin-api/admin/broadcast',
    '/admin-api/admin/broadcast/items?type=breaking',
  ];

  for (const p of paths) {
    const res = await request(app).get(p).expect(401);
    assert.ok(/json/i.test(String(res.headers['content-type'] || '')));
    assert.equal(res.body && typeof res.body, 'object');
    assert.equal(res.body.ok, false);
    assert.equal(typeof res.body.message, 'string');
  }
});

test('Public Broadcast endpoints under /admin-api/public return JSON', async () => {
  const res = await request(app)
    .get('/admin-api/public/broadcast')
    .expect(200);

  assert.ok(/json/i.test(String(res.headers['content-type'] || '')));
  assert.equal(typeof res.body, 'object');
  assert.equal(typeof res.body.breaking, 'object');
  assert.equal(typeof res.body.live, 'object');
});

test('OPTIONS preflight works for public broadcast with allowed origin', async () => {
  const res = await request(app)
    .options('/admin-api/public/broadcast')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('Access-Control-Request-Method', 'DELETE')
    .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
    .expect(204);

  assert.equal(res.headers['access-control-allow-origin'], 'https://www.newspulse.co.in');
  assert.ok(String(res.headers['access-control-allow-methods'] || '').includes('DELETE'));
});

test('OPTIONS preflight works for admin broadcast with allowed origin', async () => {
  const res = await request(app)
    .options('/admin-api/admin/broadcast')
    .set('Origin', 'https://admin.newspulse.co.in')
    .set('Access-Control-Request-Method', 'PUT')
    .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
    .expect(204);

  assert.equal(res.headers['access-control-allow-origin'], 'https://admin.newspulse.co.in');
  assert.ok(String(res.headers['access-control-allow-methods'] || '').includes('PUT'));
});

test('OPTIONS preflight works for admin broadcast items + config (no 405)', async () => {
  const paths = [
    { path: '/admin-api/admin/broadcast/items', method: 'POST' },
    { path: '/admin-api/admin/broadcast/config', method: 'PUT' },
    { path: '/admin-api/admin/broadcast/config/breaking', method: 'PATCH' },
  ];

  for (const p of paths) {
    const res = await request(app)
      .options(p.path)
      .set('Origin', 'https://admin.newspulse.co.in')
      .set('Access-Control-Request-Method', p.method)
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
      .expect(204);

    assert.equal(res.headers['access-control-allow-origin'], 'https://admin.newspulse.co.in');
    assert.ok(String(res.headers['access-control-allow-methods'] || '').includes(p.method));
  }
});

test('OPTIONS preflight works for public broadcast config with allowed origin', async () => {
  const res = await request(app)
    .options('/admin-api/public/broadcast/config')
    .set('Origin', 'https://www.newspulse.co.in')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'Content-Type')
    .expect(204);

  assert.equal(res.headers['access-control-allow-origin'], 'https://www.newspulse.co.in');
  assert.ok(String(res.headers['access-control-allow-methods'] || '').includes('GET'));
});
