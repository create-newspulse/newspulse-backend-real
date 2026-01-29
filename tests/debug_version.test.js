const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Debug: GET /_debug/version returns safe version payload', async () => {
  const res = await request(app)
    .get('/_debug/version')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.equal(res.body && typeof res.body, 'object');
  assert.equal(res.body.service, 'newspulse-backend');
  assert.equal(typeof res.body.gitSha, 'string');
  assert.equal(typeof res.body.buildTime, 'string');
  assert.ok(res.body.gitSha.length > 0);
  assert.ok(res.body.buildTime.length > 0);
});
