const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'np-private-documents-'));
const previousDirectory = process.cwd();
process.chdir(temporaryRoot);
process.env.COMMUNITY_REPORTER_UPLOAD_DIR = path.join(temporaryRoot, 'private');
process.env.COMMUNITY_REPORTER_LEGACY_ID_DIRS = '';
process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB = '1';
test.after(() => {
  process.chdir(previousDirectory);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const app = express();
const { blockPrivateReporterDocuments } = require('../lib/privateReporterDocuments');
app.use('/uploads', blockPrivateReporterDocuments, express.static(path.join(temporaryRoot, 'uploads')));
app.use('/api/community-reporter', require('../routes/communityReporter'));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function token(role = 'founder') {
  return jwt.sign({ role, email: 'test@example.invalid', type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

test('public ID intake returns a private URL; only authorized internal readers can download', async () => {
  const response = await request(app).post('/api/community-reporter/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(response.status, 201);
  assert.equal(response.body.path, undefined);
  assert.match(response.body.url, /^\/api\/community-reporter\/id-documents\//);
  assert.equal((await request(app).get(response.body.url)).status, 401);
  assert.equal((await request(app).get(response.body.url).auth(token('reporter'), { type: 'bearer' })).status, 403);
  const download = await request(app).get(response.body.url).auth(token(), { type: 'bearer' });
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, png);
  assert.equal(download.headers['cache-control'], 'private, no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['content-disposition'], /^attachment/);
});

test('legacy static ID documents are blocked while normal public article media remains readable', async () => {
  const filename = crypto.randomUUID() + '.png';
  fs.mkdirSync(path.join(temporaryRoot, 'uploads', 'community-reporter-ids'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, 'uploads', 'community-reporter-ids', filename), png);
  fs.writeFileSync(path.join(temporaryRoot, 'uploads', 'article.png'), png);
  for (const route of ['/uploads/community-reporter-ids/', '/uploads/COMMUNITY-REPORTER-IDS/', '/uploads/community-reporter%2Dids/', '/uploads/community-reporter-ids%2F']) {
    assert.equal((await request(app).get(route + filename)).status, 404);
  }
  assert.equal((await request(app).get('/uploads/article.png')).status, 200);
  assert.equal((await request(app).get('/api/community-reporter/id-documents/' + filename).auth(token(), { type: 'bearer' })).status, 200);
  assert.equal((await request(app).get('/api/community-reporter/id-documents/arbitrary.png').auth(token(), { type: 'bearer' })).status, 404);
});

test('ID intake validates signatures, MIME allowlist and size before writing', async () => {
  for (const [mime, buffer, expected] of [
    ['application/octet-stream', Buffer.from('MZ'), 400],
    ['image/png', Buffer.from('<svg>not an image</svg>'), 422],
    ['application/pdf', Buffer.from('not a PDF'), 422],
    ['image/jpeg', png, 422],
    ['image/png', Buffer.alloc(1024 * 1024 + 1), 413],
  ]) {
    const before = fs.readdirSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR);
    const response = await request(app).post('/api/community-reporter/upload-id').attach('file', buffer, { filename: 'document', contentType: mime });
    assert.equal(response.status, expected);
    assert.deepEqual(fs.readdirSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), before);
  }
  const response = await request(app).post('/api/community-reporter/upload-id').attach('file', Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF'), { filename: 'id.pdf', contentType: 'application/pdf' });
  assert.equal(response.status, 201);
});

test('current and historical custom ID directories stay private after storage changes', async (context) => {
  const originalDirectory = process.env.COMMUNITY_REPORTER_UPLOAD_DIR;
  context.after(() => {
    process.env.COMMUNITY_REPORTER_UPLOAD_DIR = originalDirectory;
    process.env.COMMUNITY_REPORTER_LEGACY_ID_DIRS = '';
  });
  const legacyDirectory = path.join(temporaryRoot, 'uploads', 'old-custom-ids');
  const secondDirectory = path.join(temporaryRoot, 'uploads', 'older-custom-ids');
  const filename = crypto.randomUUID() + '.png';
  for (const directory of [legacyDirectory, secondDirectory]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, filename), png);
  }
  process.env.COMMUNITY_REPORTER_UPLOAD_DIR = legacyDirectory;
  assert.equal((await request(app).get('/uploads/old-custom-ids/' + filename)).status, 404);
  const relativeLegacyDirectory = path.relative(path.join(__dirname, '..'), legacyDirectory);
  process.env.COMMUNITY_REPORTER_LEGACY_ID_DIRS = [' ', relativeLegacyDirectory, legacyDirectory, path.join(secondDirectory, '..', 'older-custom-ids'), ''].join(',');
  process.env.COMMUNITY_REPORTER_UPLOAD_DIR = originalDirectory;
  for (const prefix of [
    '/uploads/old-custom-ids/',
    '/uploads/older-custom-ids/',
    '/uploads/old-custom%2Dids/',
    '/uploads/old-custom-ids%2F',
    '/uploads/unused/%2e%2e/old-custom-ids/',
    '/uploads/old-custom-ids/../old-custom-ids/',
    '/uploads/old-custom-ids%5C',
    '/uploads/old-custom-ids%252F',
  ]) {
    assert.equal((await request(app).get(prefix + filename)).status, 404, prefix);
  }
  assert.equal((await request(app).head('/uploads/old-custom-ids/' + filename)).status, 404);
  assert.equal((await request(app).get('/uploads/community-reporter-ids/' + filename)).status, 404);
  assert.equal((await request(app).get('/uploads/article.png')).status, 200);
  const download = await request(app).get('/api/community-reporter/id-documents/' + filename).auth(token(), { type: 'bearer' });
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, png);
  assert.equal((await request(app).get('/api/community-reporter/id-documents/' + filename)).status, 401);
});
