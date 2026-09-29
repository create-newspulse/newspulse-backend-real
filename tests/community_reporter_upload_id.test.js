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
test.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
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
app.use(express.json());
const { blockPrivateReporterDocuments } = require('../lib/privateReporterDocuments');
app.use('/uploads', blockPrivateReporterDocuments, express.static(path.join(temporaryRoot, 'uploads')));
app.use(['/api/community-reporter', '/api/public/community-reporter'], require('../routes/communityReporter'));
const intakeFixture = express();
intakeFixture.post('/upload-id', require('../lib/privateReporterDocuments').uploadReporterDocument);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const storedFiles = new Map();
require('../services/reporterIdentityResolution.service');
require('../routes/adminCommunity');
require('../routes/adminCommunityReporter');
const accountFixture = require('./helpers/accountAuthFixture').accountAuthFixture();
test.beforeEach((context) => {
  accountFixture.install(context);
  storedFiles.clear();
  const cloudinary = require('cloudinary').v2;
  context.mock.method(require('../lib/cloudinary'), 'ensureCloudinaryConfigured', () => {});
  context.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.type, 'authenticated');
    assert.equal(options.resource_type, 'raw');
    assert.match(options.public_id, /^newspulse\/private\/community-reporter-ids\/[^/]+$/);
    return new (require('node:stream').Writable)({ write(buffer, encoding, done) {
      storedFiles.set(options.public_id, buffer);
      callback(null, { public_id: options.public_id, type: 'authenticated', resource_type: 'raw', secure_url: 'https://provider.invalid/private' });
      done();
    } });
  });
  context.mock.method(cloudinary, 'url', () => { throw new Error('Non-expiring document URL is forbidden'); });
  context.mock.method(cloudinary.utils, 'private_download_url', (publicId, format, options) => {
    assert.ok(['png', 'jpg', 'jpeg', 'pdf'].includes(format));
    assert.equal(format, path.extname(publicId).slice(1).toLowerCase());
    assert.equal(options.resource_type, 'raw');
    assert.equal(options.type, 'authenticated');
    assert.ok(options.expires_at - Math.floor(Date.now() / 1000) >= 59);
    assert.ok(options.expires_at - Math.floor(Date.now() / 1000) <= 60);
    return 'https://documents.example.invalid/' + encodeURIComponent(publicId);
  });
  context.mock.method(global, 'fetch', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'documents.example.invalid');
    const content = storedFiles.get(decodeURIComponent(parsed.pathname.slice(1)));
    return new Response(content || null, { status: content ? 200 : 404 });
  });
  context.mock.method(cloudinary.uploader, 'destroy', async () => { throw new Error('Unexpected document deletion'); });
});
function token(role = 'founder', overrides = {}) {
  return accountFixture.token(role, overrides);
}

test('public upload is unavailable before multipart parsing or document storage', async (context) => {
  const storage = require('../services/reporterDocumentStorage');
  const upload = context.mock.method(storage, 'uploadReporterDocument', () => { throw new Error('Storage must not run'); });
  const parser = context.mock.method(require('multer'), 'memoryStorage', () => { throw new Error('Multipart parsing must not run'); });
  const filesystem = ['mkdir', 'writeFile', 'readFile', 'open', 'lstat'].map(method =>
    context.mock.method(fs.promises, method, () => { throw new Error('Document filesystem access must not run'); }));
  const expected = { ok: false, code: 'JOURNALIST_VERIFICATION_NOT_AVAILABLE', message: 'Journalist verification is not currently available.' };
  for (const prefix of ['/api/community-reporter', '/api/public/community-reporter']) {
    const endpoint = prefix + '/upload-id';
    for (const response of [
      await request(app).post(endpoint),
      await request(app).post(endpoint).attach('file', png, { filename: 'id.png', contentType: 'image/png' }),
      await request(app).post(endpoint).set('Content-Type', 'multipart/form-data').send('malformed multipart'),
      await request(app).post(endpoint).auth(token(), { type: 'bearer' }).attach('file', png, { filename: 'id.png', contentType: 'image/png' }),
    ]) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, expected);
    }
  }
  assert.equal(parser.mock.calls.length, 0);
  assert.equal(upload.mock.calls.length, 0);
  for (const operation of filesystem) assert.equal(operation.mock.calls.length, 0);
  assert.equal(require('cloudinary').v2.uploader.upload_stream.mock.calls.length, 0);
  assert.equal(require('cloudinary').v2.utils.private_download_url.mock.calls.length, 0);
  const registration = require('../routes/communityReporter').stack.find(layer => layer.route?.path === '/upload-id').route;
  assert.equal(registration.stack.length, 1);
});

test('retained upload handler returns a private URL; only authorized internal readers can download', async () => {
  const response = await request(intakeFixture).post('/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(response.status, 201);
  assert.equal(response.body.path, undefined);
  assert.match(response.body.url, /^\/api\/community-reporter\/id-documents\//);
  assert.equal(response.body.url, '/api/community-reporter/id-documents/' + response.body.fileId);
  assert.equal(response.body.secure_url, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /provider\.invalid|public_id|signature|api_key/);
  assert.equal(fs.existsSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), false);
  const downloadUrl = require('cloudinary').v2.utils.private_download_url;
  assert.equal(downloadUrl.mock.calls.length, 0);
  assert.equal((await request(app).get(response.body.url)).status, 401);
  assert.equal((await request(app).get(response.body.url).auth(token('reporter'), { type: 'bearer' })).status, 403);
  assert.equal(downloadUrl.mock.calls.length, 0);
  const download = await request(app).get(response.body.url).auth(token(), { type: 'bearer' });
  assert.equal(download.status, 200);
  assert.equal(downloadUrl.mock.calls.length, 1);
  assert.equal(download.headers.location, undefined);
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
  assert.equal(require('cloudinary').v2.utils.private_download_url.mock.calls.length, 0);
});

test('ID intake validates signatures, MIME allowlist and size before writing', async () => {
  for (const [mime, buffer, expected] of [
    ['application/octet-stream', Buffer.from('MZ'), 400],
    ['image/png', Buffer.from('<svg>not an image</svg>'), 422],
    ['application/pdf', Buffer.from('not a PDF'), 422],
    ['image/jpeg', png, 422],
    ['image/png', Buffer.alloc(1024 * 1024 + 1), 413],
  ]) {
    const before = storedFiles.size;
    const response = await request(intakeFixture).post('/upload-id').attach('file', buffer, { filename: 'document', contentType: mime });
    assert.equal(response.status, expected);
    assert.equal(storedFiles.size, before);
    assert.equal(fs.existsSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), false);
  }
  const response = await request(intakeFixture).post('/upload-id').attach('file', Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF'), { filename: 'id.pdf', contentType: 'application/pdf' });
  assert.equal(response.status, 201);
  const jpeg = await request(intakeFixture).post('/upload-id').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'id.jpg', contentType: 'image/jpeg' });
  assert.equal(jpeg.status, 201);
  assert.equal(jpeg.body.mime, 'image/jpeg');
  assert.equal(fs.existsSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), false);
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

test('document storage hides authenticated Cloudinary identities behind News Pulse file IDs', async (context) => {
  const storage = require('../services/reporterDocumentStorage');
  const cloudinary = require('cloudinary').v2;
  context.mock.method(require('../lib/cloudinary'), 'ensureCloudinaryConfigured', () => {});
  let uploadedId;
  context.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.type, 'authenticated');
    assert.equal(options.resource_type, 'raw');
    assert.equal(options.overwrite, false);
    uploadedId = options.public_id;
    return new (require('node:stream').Writable)({ write(buffer, encoding, done) {
      assert.deepEqual(buffer, png);
      callback(null, { public_id: uploadedId, type: 'authenticated', resource_type: 'raw', secure_url: 'https://provider.invalid/private' });
      done();
    } });
  });
  const uploaded = await storage.uploadReporterDocument({ buffer: png, mimeType: 'image/png' });
  assert.equal(storage.isReporterDocumentId(uploaded.fileId), true);
  assert.equal(uploadedId, 'newspulse/private/community-reporter-ids/' + uploaded.fileId);
  assert.deepEqual(uploaded, { fileId: uploaded.fileId, url: '/api/community-reporter/id-documents/' + uploaded.fileId, mime: 'image/png', size: png.length });
  const now = Math.floor(Date.now() / 1000);
  context.mock.method(cloudinary.utils, 'private_download_url', (publicId, format, options) => {
    assert.equal(publicId, uploadedId);
    assert.equal(format, 'png');
    assert.ok(options.expires_at >= now + 60 && options.expires_at <= now + 61);
    assert.deepEqual(options, { resource_type: 'raw', type: 'authenticated', expires_at: options.expires_at, secure: true });
    return 'https://provider.invalid/signed';
  });
  context.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://provider.invalid/signed');
    assert.equal(options.redirect, 'error');
    return new Response(png);
  });
  const access = await storage.getReporterDocumentAccess(uploaded.fileId);
  const chunks = [];
  for await (const chunk of access.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
  assert.deepEqual(Object.keys(access).sort(), ['filename', 'stream']);
  context.mock.method(cloudinary.uploader, 'destroy', async (publicId, options) => {
    assert.equal(publicId, uploadedId);
    assert.deepEqual(options, { resource_type: 'raw', type: 'authenticated', invalidate: true });
    return { result: 'ok' };
  });
  assert.deepEqual(await storage.deleteReporterDocument(uploaded.fileId), { deleted: true });
  for (const invalid of ['https://provider.invalid/document.png', '../document.png', uploadedId]) {
    assert.equal(storage.isReporterDocumentId(invalid), false);
    assert.equal(await storage.getReporterDocumentAccess(invalid), null);
    await assert.rejects(storage.deleteReporterDocument(invalid), /Invalid document identifier/);
  }
});

test('storage failures do not leak provider details or fall back to disk', async (context) => {
  context.mock.method(require('../lib/cloudinary'), 'ensureCloudinaryConfigured', () => {
    throw Object.assign(new Error('Synthetic private provider detail'), { status: 503 });
  });
  const upload = await request(intakeFixture).post('/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(upload.status, 503);
  assert.deepEqual(upload.body, { ok: false, message: 'UPLOAD_FAILED' });
  assert.equal(fs.existsSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), false);
  const download = await request(app).get('/api/community-reporter/id-documents/' + crypto.randomUUID() + '.png').auth(token(), { type: 'bearer' });
  assert.equal(download.status, 503);
  assert.deepEqual(download.body, { ok: false, message: 'Document unavailable' });
});

test('raw downloads preserve the full public ID and supply the validated PNG, JPEG or PDF format', async () => {
  const storage = require('../services/reporterDocumentStorage');
  const downloadUrl = require('cloudinary').v2.utils.private_download_url;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const pdf = Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF');
  for (const [extension, expectedFormat, bytes] of [
    ['png', 'png', png],
    ['jpg', 'jpg', jpeg],
    ['jpeg', 'jpeg', jpeg],
    ['pdf', 'pdf', pdf],
    ['JPEG', 'jpeg', jpeg],
  ]) {
    const fileId = crypto.randomUUID() + '.' + extension;
    const publicId = 'newspulse/private/community-reporter-ids/' + fileId;
    storedFiles.set(publicId, bytes);
    const before = Math.floor(Date.now() / 1000);
    const access = await storage.getReporterDocumentAccess(fileId);
    const after = Math.floor(Date.now() / 1000);
    const [actualPublicId, format, options] = downloadUrl.mock.calls.at(-1).arguments;
    assert.equal(actualPublicId, publicId);
    assert.equal(format, expectedFormat);
    assert.equal(options.resource_type, 'raw');
    assert.equal(options.type, 'authenticated');
    assert.ok(options.expires_at >= before + 60 && options.expires_at <= after + 60);
    const chunks = [];
    for await (const chunk of access.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  }
  const calls = downloadUrl.mock.calls.length;
  for (const suffix of ['gif', 'png.exe', 'png?format=pdf', '']) {
    assert.equal(await storage.getReporterDocumentAccess(crypto.randomUUID() + '.' + suffix), null);
  }
  assert.equal(downloadUrl.mock.calls.length, calls);
});

test('submission routes accept stories without documents and persist only opaque document IDs', async (context) => {
  require('mongoose').connection.readyState = 0;
  const CommunitySubmission = require('../models/CommunitySubmission');
  const captured = [];
  context.mock.method(CommunitySubmission, 'create', async payload => {
    captured.push(payload);
    return { ...payload, _id: '507f1f77bcf86cd799439021' };
  });
  const contacts = require('../services/reporterContactService');
  context.mock.method(contacts, 'upsertReporterContactFromPayload', async () => null);
  context.mock.method(contacts, 'upsertReporterContactFromSubmission', async () => null);
  context.mock.method(require('../services/reporterIdentityResolution.service'), 'resolveAndAttachForSubmission', async () => ({ ok: true }));
  context.mock.method(console, 'log', () => {});
  const upload = await request(intakeFixture).post('/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(upload.status, 201);
  for (const route of ['/api/community-reporter/submissions', '/api/community-reporter/submit', '/api/public/community-reporter/submissions', '/api/public/community-reporter/submit']) {
    const body = { name: 'Synthetic Reporter', email: 'reporter@example.invalid', location: 'Sample City', category: 'General Tip', headline: 'Test headline', story: 'Test story', ageGroup: '18_24' };
    for (const input of [
      {},
      { reporterDocumentId: upload.body.fileId },
      { journalistIdFileId: upload.body.fileId },
      { reporterDocumentId: upload.body.fileId, journalistIdFileId: upload.body.fileId },
    ]) {
      const response = await request(app).post(route).send({ ...body, ...input });
      assert.equal(response.status, 201, route);
      const stored = captured.at(-1);
      assert.equal(stored.reporterDocumentId, input.reporterDocumentId || input.journalistIdFileId || null);
      assert.equal(Object.hasOwn(stored, 'journalistIdFileId'), false);
      assert.deepEqual(stored.attachments, []);
      assert.equal(stored.mediaUrl, undefined);
      assert.equal(JSON.stringify(stored).includes('cloudinary'), false);
      assert.equal(JSON.stringify(response.body).includes(upload.body.fileId), false);
      assert.doesNotMatch(JSON.stringify(response.body), /reporterDocumentId|journalistIdFileId/);
    }
    const count = captured.length;
    for (const invalid of ['https://res.cloudinary.com/example/raw/authenticated/document.pdf', 'newspulse/private/community-reporter-ids/' + upload.body.fileId, upload.body.url, '../private.pdf', {}, '', null]) {
      for (const field of ['reporterDocumentId', 'journalistIdFileId']) {
        const denied = await request(app).post(route).send({ ...body, [field]: invalid });
        assert.equal(denied.status, 400);
        assert.equal(denied.body.code, 'INVALID_REPORTER_DOCUMENT_ID');
      }
    }
    for (const conflict of [crypto.randomUUID() + '.pdf', null, 'invalid']) {
      const denied = await request(app).post(route).send({ ...body, reporterDocumentId: upload.body.fileId, journalistIdFileId: conflict });
      assert.equal(denied.status, 400);
      assert.equal(denied.body.code, 'CONFLICTING_REPORTER_DOCUMENT_IDS');
    }
    assert.equal(captured.length, count);
  }
  const document = new CommunitySubmission({ reporterDocumentId: upload.body.fileId });
  assert.equal(document.validateSync()?.errors.reporterDocumentId, undefined);
  document.reporterDocumentId = 'https://res.cloudinary.com/example/document.pdf';
  assert.ok(document.validateSync().errors.reporterDocumentId);
  assert.equal(CommunitySubmission.schema.path('reporterDocumentId').options.select, false);
  assert.equal(CommunitySubmission.schema.path('journalistIdFileId'), undefined);
});

test('authorized internal detail views select the opaque document ID without changing their response envelope', async (context) => {
  const fileId = crypto.randomUUID() + '.png';
  const submissionId = '507f1f77bcf86cd799439021';
  let queries = 0;
  context.mock.method(require('../models/CommunitySubmission'), 'findById', (id, projection) => {
    assert.equal(id, submissionId);
    assert.equal(projection, '+reporterDocumentId');
    queries += 1;
    return { lean: async () => ({ _id: submissionId, reporterDocumentId: fileId }) };
  });
  for (const routerPath of ['../routes/adminCommunity', '../routes/adminCommunityReporter']) {
    const fixture = express();
    fixture.use(require(routerPath));
    const endpoint = '/submissions/' + submissionId;
    const before = queries;
    assert.equal((await request(fixture).get(endpoint)).status, 401);
    assert.equal((await request(fixture).get(endpoint).auth(token('reporter'), { type: 'bearer' })).status, 403);
    assert.equal(queries, before);
    const response = await request(fixture).get(endpoint).auth(token(), { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.submission.reporterDocumentId, fileId);
  }
});

test('queue-granted staff can download only after News Pulse authorization, with no signing on denial', async (context) => {
  const upload = await request(intakeFixture).post('/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(upload.status, 201);
  const mongoose = require('mongoose');
  const previousState = mongoose.connection.readyState;
  const previousDb = mongoose.connection.db;
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.readyState = previousState; mongoose.connection.db = previousDb; });
  const user = { _id: '507f1f77bcf86cd799439011', role: 'editor', status: 'active', tokenVersion: 0, moduleAccessStates: { communityReporterQueue: 'enabled' } };
  const settings = { adminModulePolicy: { version: 1, modulePolicies: { communityReporterQueue: 'available' } } };
  context.mock.method(require('../models/User'), 'findById', () => ({ lean: async () => user }));
  context.mock.method(require('../models/SiteSettings'), 'findOne', async () => settings);
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  const downloadUrl = require('cloudinary').v2.utils.private_download_url;
  const credential = token('editor', { sub: user._id });
  assert.equal(downloadUrl.mock.calls.length, 0);
  const allowed = await request(app).get(upload.body.url).auth(credential, { type: 'bearer' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, png);
  assert.equal(downloadUrl.mock.calls.length, 1);
  user.moduleAccessStates.communityReporterQueue = 'disabled';
  assert.equal((await request(app).get(upload.body.url).auth(credential, { type: 'bearer' })).status, 403);
  user.moduleAccessStates.communityReporterQueue = 'enabled';
  settings.adminModulePolicy.modulePolicies.communityReporterQueue = 'staff_locked';
  assert.equal((await request(app).get(upload.body.url).auth(credential, { type: 'bearer' })).status, 403);
  assert.equal(downloadUrl.mock.calls.length, 1);
});

test('reporter-facing story responses strip both document fields even from legacy raw records', async (context) => {
  const fileId = crypto.randomUUID() + '.png';
  const record = { _id: '507f1f77bcf86cd799439021', headline: 'Synthetic headline', reporterDocumentId: fileId, journalistIdFileId: fileId };
  context.mock.method(require('../models/CommunitySubmission'), 'find', () => ({ sort: () => ({ lean: async () => [record] }) }));
  const router = require('../routes/communityReporter');
  for (const route of ['/my-stories', '/reporter-stories']) {
    const handler = router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle;
    const fixture = express();
    fixture.get(route, (req, res) => {
      req.reporterPortal = { reporterId: '507f1f77bcf86cd799439011' };
      return handler(req, res);
    });
    const response = await request(fixture).get(route);
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /reporterDocumentId|journalistIdFileId/);
    assert.equal(JSON.stringify(response.body).includes(fileId), false);
    assert.equal(response.body.stories[0].headline, record.headline);
  }
  assert.equal(record.reporterDocumentId, fileId);
  assert.equal(record.journalistIdFileId, fileId);
});

test('provider upload errors fail closed without returning or logging provider details', async (context) => {
  const details = 'synthetic-provider-sensitive-detail';
  const logs = [];
  for (const method of ['log', 'warn', 'error']) context.mock.method(console, method, (...args) => logs.push(args));
  context.mock.method(require('cloudinary').v2.uploader, 'upload_stream', (options, callback) => new (require('node:stream').Writable)({ write(buffer, encoding, done) {
    callback(new Error(details));
    done();
  } }));
  const response = await request(intakeFixture).post('/upload-id').attach('file', png, { filename: 'id.png', contentType: 'image/png' });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { ok: false, message: 'UPLOAD_FAILED' });
  assert.equal(fs.existsSync(process.env.COMMUNITY_REPORTER_UPLOAD_DIR), false);
  assert.equal(JSON.stringify(logs).includes(details), false);
});

test('portal list, detail and summary responses omit private document metadata', async (context) => {
  const record = { _id: '507f1f77bcf86cd799439021', headline: 'Synthetic headline', status: 'NEW', reporterDocumentId: crypto.randomUUID() + '.png', journalistIdFileId: crypto.randomUUID() + '.pdf' };
  const CommunitySubmission = require('../models/CommunitySubmission');
  context.mock.method(CommunitySubmission, 'find', () => ({ sort: async () => [record] }));
  context.mock.method(CommunitySubmission, 'findOne', async () => record);
  context.mock.method(console, 'log', () => {});
  const router = require('../routes/reporterPortal');
  for (const route of ['/submissions', '/submissions/:id', '/dashboard/summary', '/submissions/stats']) {
    const handler = router.stack.find(layer => layer.route?.path === route && layer.route.methods.get).route.stack.at(-1).handle;
    const fixture = express();
    fixture.get(route, (req, res) => {
      req.reporterPortal = { reporterId: '507f1f77bcf86cd799439011', email: 'reporter@example.invalid' };
      return handler(req, res);
    });
    const response = await request(fixture).get(route.replace(':id', record._id));
    assert.equal(response.status, 200, route);
    assert.doesNotMatch(JSON.stringify(response.body), /reporterDocumentId|journalistIdFileId/);
    assert.equal(JSON.stringify(response.body).includes(record.reporterDocumentId), false);
    assert.equal(JSON.stringify(response.body).includes(record.journalistIdFileId), false);
  }
});
