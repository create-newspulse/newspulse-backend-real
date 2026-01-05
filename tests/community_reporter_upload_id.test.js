const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

process.env.NODE_ENV = 'test';
require('dotenv').config();

// Keep uploads isolated for tests
process.env.COMMUNITY_REPORTER_UPLOAD_DIR = process.env.COMMUNITY_REPORTER_UPLOAD_DIR || 'uploads/community-reporter-ids-test';
process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB = process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB || '5';

const app = require('../server');

function cleanupUploadedFile(urlOrPath) {
  if (!urlOrPath) return;

  // If we got a public URL like /uploads/..., map it to disk under projectRoot/uploads
  if (typeof urlOrPath === 'string' && urlOrPath.startsWith('/uploads/')) {
    const rel = urlOrPath.replace(/^\/uploads\//, '');
    const filePath = path.join(__dirname, '..', 'uploads', ...rel.split('/'));
    try { fs.unlinkSync(filePath); } catch (_) {}
    return;
  }

  // If we got a raw filesystem path
  if (typeof urlOrPath === 'string') {
    try { fs.unlinkSync(urlOrPath); } catch (_) {}
  }
}

test('Community reporter upload-id: happy path (png) + retrievable', async () => {
  // Minimal PNG signature (content validity isn't checked; mimetype is)
  const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const res = await request(app)
    .post('/api/community-reporter/upload-id')
    .field('email', 'reporter@example.com')
    .field('reporterId', 'r-123')
    .field('note', 'test upload')
    .attach('file', pngBytes, { filename: 'id.png', contentType: 'image/png' });

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.fileId, 'fileId returned');
  assert.strictEqual(res.body.mime, 'image/png');
  assert.strictEqual(res.body.size, pngBytes.length);
  assert.ok(res.body.originalName);

  const location = res.body.url || res.body.path;
  assert.ok(location, 'url/path returned');

  if (res.body.url) {
    const getRes = await request(app).get(res.body.url);
    assert.strictEqual(getRes.statusCode, 200);
    assert.ok(String(getRes.headers['content-type'] || '').includes('image/png'));
    assert.strictEqual(Buffer.isBuffer(getRes.body), true);
  }

  cleanupUploadedFile(location);
});

test('Community reporter upload-id: rejects wrong mime type', async () => {
  const exeBytes = Buffer.from('MZ');

  const res = await request(app)
    .post('/api/community-reporter/upload-id')
    .attach('file', exeBytes, { filename: 'evil.exe', contentType: 'application/octet-stream' });

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { ok: false, message: 'INVALID_FILE_TYPE' });
});
