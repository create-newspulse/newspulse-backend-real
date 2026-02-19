const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('GET /admin-api/ai/models/status returns resolved models + modes', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/admin-api/ai/models/status')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.resolvedOpenAIModel, 'string');
  assert.equal(typeof res.body.resolvedGeminiModel, 'string');
  assert.ok(res.body.modes && typeof res.body.modes === 'object');
  assert.ok(['auto', 'pinned'].includes(res.body.modes.openaiMode));
  assert.ok(['latest', 'pinned'].includes(res.body.modes.geminiMode));

  // In NODE_ENV=test, external OpenAI calls are disabled; we should see fallback.
  const expectedFallback = String(process.env.OPENAI_FALLBACK_MODEL || '').trim() || 'gpt-5';
  assert.equal(res.body.resolvedOpenAIModel, expectedFallback);

  // Default Gemini latest alias
  assert.equal(res.body.resolvedGeminiModel, 'gemini-pro-latest');
});

test('GET /ai/models/status compatibility alias returns same shape', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/ai/models/status')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.resolvedOpenAIModel, 'string');
  assert.equal(typeof res.body.resolvedGeminiModel, 'string');
});

test('POST /admin-api/ai/models/refresh returns 200 and refreshes cache', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .post('/admin-api/ai/models/refresh')
    .set('Authorization', `Bearer ${token}`)
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.lastRefreshedAt, 'string');
  assert.equal(typeof res.body.resolvedOpenAIModel, 'string');
  assert.equal(typeof res.body.resolvedGeminiModel, 'string');
});
