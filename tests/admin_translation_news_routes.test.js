const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

// Ensure Phase 2 News translation endpoints are mounted and protected by admin auth.

test('Admin Translations (news): enqueue route exists and requires auth (401)', async () => {
  const fakeId = '64b64c2f2f2f2f2f2f2f2f2f';
  const endpoints = [
    { method: 'post', path: `/api/admin/translations/news/${fakeId}/enqueue` },
    { method: 'post', path: `/admin-api/admin/translations/news/${fakeId}/enqueue` },
    { method: 'post', path: `/admin-api/api/admin/translations/news/${fakeId}/enqueue` },
  ];

  for (const ep of endpoints) {
    const res = await request(app)[ep.method](ep.path).set('Content-Type', 'application/json');
    assert.equal(res.status, 401, `${ep.method.toUpperCase()} ${ep.path} should return 401 (not ${res.status})`);
    assert.ok(String(res.headers['content-type'] || '').includes('application/json'));
  }
});
