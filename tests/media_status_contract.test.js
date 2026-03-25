const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

function assertStableMediaStatusContract(body) {
  assert.equal(body && typeof body, 'object');

  const keys = Object.keys(body).sort();
  const expected = ['available', 'configured', 'message', 'ok', 'provider', 'reason'].sort();
  assert.deepEqual(keys, expected);

  assert.equal(typeof body.ok, 'boolean');
  assert.equal(typeof body.provider, 'string');
  assert.equal(typeof body.available, 'boolean');
  assert.equal(typeof body.configured, 'boolean');
  assert.equal(typeof body.message, 'string');

  const reasonType = body.reason === null ? 'null' : typeof body.reason;
  assert.ok(reasonType === 'string' || reasonType === 'null');

  if (body.available) {
    assert.equal(body.reason, null);
  } else {
    assert.equal(typeof body.reason, 'string');
    assert.ok(body.reason.length > 0);
  }
}

test('GET /api/media/status returns stable contract', async () => {
  const res = await request(app)
    .get('/api/media/status')
    .expect('Content-Type', /json/)
    .expect(200);

  assertStableMediaStatusContract(res.body);
});

test('GET /admin-api/media/status returns stable contract', async () => {
  const res = await request(app)
    .get('/admin-api/media/status')
    .expect('Content-Type', /json/)
    .expect(200);

  assertStableMediaStatusContract(res.body);
});

test('GET /admin-api/api/media/status returns stable contract (compat alias)', async () => {
  const res = await request(app)
    .get('/admin-api/api/media/status')
    .expect('Content-Type', /json/)
    .expect(200);

  assertStableMediaStatusContract(res.body);
});
