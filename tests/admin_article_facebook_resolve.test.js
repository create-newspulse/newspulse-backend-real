const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  return `np.${Buffer.from(`${email}:0`).toString('base64')}`;
}

function redirectResponse(location, status = 302) {
  return {
    status,
    headers: { get: (name) => (String(name || '').toLowerCase() === 'location' ? location : null) },
  };
}

function stubFetch(t, fetchImpl) {
  const previous = global.fetch;
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = previous; });
}

function postResolve(body, token = makeOpaqueAdminToken()) {
  const req = request(app).post('/api/admin/articles/media/facebook/resolve');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

test('Facebook share resolver endpoint requires Admin auth', async () => {
  const res = await postResolve({ url: 'https://www.facebook.com/share/r/shareToken_123/' }, null);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('Facebook share resolver endpoint resolves Reel destination canonically', async (t) => {
  const calls = [];
  stubFetch(t, async (url, opts) => {
    calls.push({ url, opts });
    return redirectResponse('https://www.facebook.com/reel/123456789012345/?utm_source=share');
  });

  const res = await postResolve({ url: 'https://www.facebook.com/share/r/shareToken_123/' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, url: 'https://www.facebook.com/reel/123456789012345' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.redirect, 'manual');
});

test('Facebook share resolver endpoint resolves post destination canonically', async (t) => {
  stubFetch(t, async () => redirectResponse('https://facebook.com/NewsPulseAI/posts/123456789012345?utm_source=share'));

  const res = await postResolve({ url: 'https://facebook.com/share/r/postShare_123/' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, url: 'https://www.facebook.com/NewsPulseAI/posts/123456789012345' });
});

test('Facebook share resolver endpoint returns 400 for malformed input', async (t) => {
  let fetchCalled = false;
  stubFetch(t, async () => {
    fetchCalled = true;
    return redirectResponse('https://www.facebook.com/reel/123456789012345/');
  });

  const missing = await postResolve({});
  const malformed = await postResolve({ url: 'https://www.facebook.com/share/r/bad.token/' });

  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, 'INVALID_FACEBOOK_SHARE_URL');
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.code, 'INVALID_FACEBOOK_SHARE_URL');
  assert.equal(fetchCalled, false);
});

test('Facebook share resolver endpoint returns safe error for unsupported destinations', async (t) => {
  stubFetch(t, async () => redirectResponse('https://www.facebook.com/stories/NewsPulseAI/123456789012345/'));

  const res = await postResolve({ url: 'https://www.facebook.com/share/r/shareToken_123/' });

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { ok: false, code: 'FACEBOOK_SHARE_RESOLVE_FAILED' });
});

test('Facebook share resolver endpoint rejects non-Facebook redirects safely', async (t) => {
  stubFetch(t, async () => redirectResponse('https://example.com/reel/123456789012345'));

  const res = await postResolve({ url: 'https://www.facebook.com/share/r/shareToken_123/' });

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { ok: false, code: 'FACEBOOK_SHARE_RESOLVE_FAILED' });
});

test('Facebook share resolver endpoint does not leak resolver internals', async (t) => {
  stubFetch(t, async () => {
    throw new Error('internal upstream token secret-stack-trace');
  });

  const res = await postResolve({ url: 'https://www.facebook.com/share/r/shareToken_123/' });
  const bodyText = JSON.stringify(res.body);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { ok: false, code: 'FACEBOOK_SHARE_RESOLVE_FAILED' });
  assert.equal(bodyText.includes('secret-stack-trace'), false);
  assert.equal(bodyText.includes('internal upstream'), false);
});