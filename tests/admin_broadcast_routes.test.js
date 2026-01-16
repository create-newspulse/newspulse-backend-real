const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

// These tests ensure the standardized Broadcast Center admin routes exist and
// are protected by admin auth (401 when unauthenticated) rather than 404.

test('Admin Broadcast (standard): routes are mounted and require auth (401)', async () => {
  const endpoints = [
    { method: 'get', path: '/api/admin/broadcast' },
    { method: 'put', path: '/api/admin/broadcast' },
    { method: 'patch', path: '/api/admin/broadcast' },

    { method: 'get', path: '/api/admin/broadcast/items?type=breaking' },
    { method: 'post', path: '/api/admin/broadcast/items' },
    { method: 'patch', path: '/api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },
    { method: 'delete', path: '/api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },
  ];

  for (const ep of endpoints) {
    const res = await request(app)[ep.method](ep.path).set('Content-Type', 'application/json');
    assert.equal(res.status, 401, `${ep.method.toUpperCase()} ${ep.path} should return 401 (not ${res.status})`);
    assert.ok(String(res.headers['content-type'] || '').includes('application/json'));
  }
});

test('Admin Broadcast (aliases): /admin-api/admin/broadcast is mounted and requires auth (401)', async () => {
  const endpoints = [
    { method: 'get', path: '/admin-api/admin/broadcast' },
    { method: 'put', path: '/admin-api/admin/broadcast' },
    { method: 'patch', path: '/admin-api/admin/broadcast' },

    { method: 'get', path: '/admin-api/admin/broadcast/items?type=live' },
    { method: 'post', path: '/admin-api/admin/broadcast/items' },
    { method: 'patch', path: '/admin-api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },
    { method: 'delete', path: '/admin-api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },

    // Some admin panels proxy through /admin-api/api/*
    { method: 'get', path: '/admin-api/api/admin/broadcast' },
    { method: 'put', path: '/admin-api/api/admin/broadcast' },
    { method: 'patch', path: '/admin-api/api/admin/broadcast' },
    { method: 'get', path: '/admin-api/api/admin/broadcast/items?type=live' },
    { method: 'post', path: '/admin-api/api/admin/broadcast/items' },
    { method: 'patch', path: '/admin-api/api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },
    { method: 'delete', path: '/admin-api/api/admin/broadcast/items/64b64c2f2f2f2f2f2f2f2f2f' },
  ];

  for (const ep of endpoints) {
    const res = await request(app)[ep.method](ep.path).set('Content-Type', 'application/json');
    assert.equal(res.status, 401, `${ep.method.toUpperCase()} ${ep.path} should return 401 (not ${res.status})`);
    assert.ok(String(res.headers['content-type'] || '').includes('application/json'));
  }
});
