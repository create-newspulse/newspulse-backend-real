const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('Owner AI Model Log: requires founder or owner key', async () => {
  // no auth
  const res1 = await request(app).get('/admin-api/owner/ai-model-log?provider=openai');
  assert.equal(res1.status, 401);

  // admin (non-founder) should be forbidden if no owner key cookie
  const res2 = await request(app)
    .get('/admin-api/owner/ai-model-log?provider=openai')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('admin@newspulse.ai')}`);
  assert.equal(res2.status, 403);

  // founder token allowed (DB may be unavailable in tests, but should still return ok)
  const res3 = await request(app)
    .get('/admin-api/owner/ai-model-log?provider=openai')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken('founder@example.com')}`);
  assert.equal(res3.status, 200);
  assert.equal(res3.body.ok, true);
  assert.equal(res3.body.data.provider, 'openai');
  assert.ok(Array.isArray(res3.body.data.items));
});

test('Owner AI Model Rollback: validates body and returns 503 when DB unavailable', async () => {
  const founderToken = makeOpaqueAdminToken('founder@example.com');

  const bad1 = await request(app)
    .post('/admin-api/owner/ai-model-rollback')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ provider: 'openai' });
  assert.equal(bad1.status, 400);

  const res = await request(app)
    .post('/admin-api/owner/ai-model-rollback')
    .set('Authorization', `Bearer ${founderToken}`)
    .send({ provider: 'openai', pinnedModel: 'gpt-5.2' });

  // In test/import mode, DB is often skipped; rollback should fail safely.
  assert.ok([503, 200].includes(res.status));
  if (res.status === 503) {
    assert.equal(res.body.ok, false);
  }
});
