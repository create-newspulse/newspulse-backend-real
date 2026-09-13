const test = require('node:test');
const assert = require('node:assert/strict');

const adImageUpload = require('../src/utils/adImageUpload');

const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function installLookup(t, map) {
  const previous = global.__NEWS_PULSE_AD_IMAGE_LOOKUP__;
  global.__NEWS_PULSE_AD_IMAGE_LOOKUP__ = async (hostname, options) => {
    const value = map[String(hostname).toLowerCase()];
    if (!value) {
      const err = new Error('ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    }
    const entries = Array.isArray(value) ? value : [value];
    if (options && options.all) return entries.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const first = entries[0];
    return { address: first, family: first.includes(':') ? 6 : 4 };
  };
  t.after(() => {
    if (previous === undefined) delete global.__NEWS_PULSE_AD_IMAGE_LOOKUP__;
    else global.__NEWS_PULSE_AD_IMAGE_LOOKUP__ = previous;
  });
}

function installHttpClient(t, handler) {
  const previous = global.__NEWS_PULSE_AD_IMAGE_HTTP_CLIENT__;
  global.__NEWS_PULSE_AD_IMAGE_HTTP_CLIENT__ = {
    get: async (url, options) => handler(url, options),
  };
  t.after(() => {
    if (previous === undefined) delete global.__NEWS_PULSE_AD_IMAGE_HTTP_CLIENT__;
    else global.__NEWS_PULSE_AD_IMAGE_HTTP_CLIENT__ = previous;
  });
}

async function assertRejectsUrl(url, codeOrMessage) {
  await assert.rejects(
    () => adImageUpload.downloadImageToBuffer(url),
    (err) => {
      assert.equal(err.status === 400 || err.status === 413 || err.status === 422, true);
      if (codeOrMessage instanceof RegExp) assert.match(err.message, codeOrMessage);
      else assert.equal(err.code, codeOrMessage);
      return true;
    }
  );
}

test('remote ad image rejects private and special URL targets before fetch', async () => {
  await assertRejectsUrl('http://127.0.0.1/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://localhost/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://10.1.2.3/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://172.16.0.1/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://172.31.255.255/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://192.168.1.10/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://169.254.169.254/latest/meta-data', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://[::1]/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://[fc00::1]/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://[fe80::1]/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('ftp://example.com/image.png', 'INVALID_REMOTE_IMAGE_URL');
});

test('remote ad image rejects hostnames resolving to private addresses', async (t) => {
  installLookup(t, { 'private.example': '192.168.1.50' });

  await assertRejectsUrl('http://private.example/image.png', 'UNSAFE_REMOTE_IMAGE_HOST');
});

test('remote ad image rejects redirects to private and metadata hosts', async (t) => {
  installLookup(t, {
    'public.example': '93.184.216.34',
    'metadata.example': '169.254.169.254',
  });
  installHttpClient(t, async (url) => {
    if (new URL(url).pathname === '/metadata') {
      return { status: 302, headers: { location: 'http://metadata.example/latest/meta-data' }, data: Buffer.alloc(0) };
    }
    return { status: 302, headers: { location: 'http://127.0.0.1/private.png' }, data: Buffer.alloc(0) };
  });

  await assertRejectsUrl('http://public.example/private', 'UNSAFE_REMOTE_IMAGE_HOST');
  await assertRejectsUrl('http://public.example/metadata', 'UNSAFE_REMOTE_IMAGE_HOST');
});

test('remote ad image rejects excessive redirects', async (t) => {
  installLookup(t, { 'public.example': '93.184.216.34' });
  installHttpClient(t, async (url) => {
    const n = Number(new URL(url).searchParams.get('n') || '0');
    return { status: 302, headers: { location: `http://public.example/redirect?n=${n + 1}` }, data: Buffer.alloc(0) };
  });

  await assertRejectsUrl('http://public.example/redirect?n=0', 'REMOTE_IMAGE_TOO_MANY_REDIRECTS');
});

test('remote ad image rejects oversized, non-image, and MIME/signature mismatch responses', async (t) => {
  installLookup(t, { 'public.example': '93.184.216.34' });
  installHttpClient(t, async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/large') {
      return { status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.concat([VALID_PNG, Buffer.alloc(adImageUpload.MAX_BYTES + 1)]) };
    }
    if (pathname === '/html') {
      return { status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>not an image</html>') };
    }
    return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: VALID_PNG };
  });

  await assertRejectsUrl('http://public.example/large', /max 5MB|maxContentLength/i);
  await assertRejectsUrl('http://public.example/html', /Unsupported image type/);
  await assertRejectsUrl('http://public.example/mismatch', /does not match/);
});

test('remote ad image accepts a safe public HTTPS image path with matching signature', async (t) => {
  installLookup(t, { 'public.example': '93.184.216.34' });
  installHttpClient(t, async () => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, data: VALID_JPEG }));

  const result = await adImageUpload.downloadImageToBuffer('https://public.example/safe.jpg');

  assert.deepEqual(result.buffer, VALID_JPEG);
  assert.equal(result.contentType, 'image/jpeg');
});
