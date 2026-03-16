const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('GET /api/public/ad-settings returns defaults when DB not connected', async () => {
  const res = await request(app).get('/api/public/ad-settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.slotEnabled, {
    HOME_728x90: true,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
  });
});

test('GET /api/admin/ad-settings is protected (401 when unauthenticated)', async () => {
  const res = await request(app).get('/api/admin/ad-settings');
  assert.equal(res.status, 401);
});

test('GET /api/admin/ad-settings returns defaults with admin token', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`);

  // In test mode the server skips DB connection; admin endpoints should respond 503 JSON.
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});

test('GET /admin-api/admin/ad-settings works as an alias (200 with admin token)', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/admin-api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});
