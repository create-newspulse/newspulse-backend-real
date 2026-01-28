const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

test('Public API Translate: CORS override applies for allowed origin', async () => {
  const prev = process.env.GOOGLE_TRANSLATE_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_API_KEY;

  const res = await request(app)
    .post('/public-api/translate')
    .set('Origin', 'https://www.newspulse.co.in')
    .send({ target: 'en', texts: ['hello'] });

  // Always ensure CORS header is present for allowed origin.
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.newspulse.co.in');

  // Restore env
  if (prev !== undefined) process.env.GOOGLE_TRANSLATE_API_KEY = prev;
});

test('Public API Translate: rejects invalid target', async () => {
  const res = await request(app)
    .post('/public-api/translate')
    .send({ target: 'fr', texts: ['hello'] })
    .expect(400);

  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error || ''), /Invalid target/i);
});

test('Public API Translate: enforces max texts', async () => {
  const texts = Array.from({ length: 51 }, (_, i) => `t${i}`);
  const res = await request(app)
    .post('/public-api/translate')
    .send({ target: 'en', texts })
    .expect(400);

  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error || ''), /Too many texts/i);
});

test('Public API Translate: missing GOOGLE_TRANSLATE_API_KEY returns clear error', async () => {
  const prev = process.env.GOOGLE_TRANSLATE_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_API_KEY;

  const res = await request(app)
    .post('/public-api/translate')
    .send({ target: 'en', texts: ['hello'] })
    .expect(500);

  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error || ''), /GOOGLE_TRANSLATE_API_KEY/i);

  if (prev !== undefined) process.env.GOOGLE_TRANSLATE_API_KEY = prev;
});
