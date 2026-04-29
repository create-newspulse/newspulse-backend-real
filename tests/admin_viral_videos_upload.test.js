const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const ViralVideo = require('../models/ViralVideo');
const mediaLibraryStorage = require('../lib/mediaLibraryStorage');
const mediaLibraryService = require('../services/mediaLibraryService');
const { VIRAL_VIDEOS_SETTINGS_KEY } = require('../lib/viralVideosSettings');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = 1;
}

function makeFindResult(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

test('GET /api/admin/viral-videos/settings returns default settings shape', async (t) => {
  stubDbReady(t);

  const prevFindOne = SystemSetting.findOne;
  t.after(() => { SystemSetting.findOne = prevFindOne; });

  SystemSetting.findOne = () => ({ lean: async () => null });

  const res = await request(app)
    .get('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { frontendEnabled: true },
  });
});

test('PUT /api/admin/viral-videos/settings persists frontendEnabled false in isolated SystemSetting', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => { SystemSetting.findOneAndUpdate = prevFindOneAndUpdate; });

  let capturedFilter = null;
  let capturedUpdate = null;
  let capturedOptions = null;

  SystemSetting.findOneAndUpdate = (filter, update, options) => {
    capturedFilter = filter;
    capturedUpdate = update;
    capturedOptions = options;
    return { lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: update.$set.value }) };
  };

  const res = await request(app)
    .put('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ frontendEnabled: false });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { frontendEnabled: false },
  });
  assert.deepEqual(capturedFilter, { key: VIRAL_VIDEOS_SETTINGS_KEY });
  assert.deepEqual(capturedUpdate.$set.value, { frontendEnabled: false });
  assert.equal(capturedUpdate.$set.key, VIRAL_VIDEOS_SETTINGS_KEY);
  assert.deepEqual(capturedOptions, { upsert: true, new: true });
});

test('GET /api/admin/viral-videos/settings returns saved frontendEnabled false', async (t) => {
  stubDbReady(t);

  const prevFindOne = SystemSetting.findOne;
  t.after(() => { SystemSetting.findOne = prevFindOne; });

  SystemSetting.findOne = (filter) => {
    assert.deepEqual(filter, { key: VIRAL_VIDEOS_SETTINGS_KEY });
    return { lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: false } }) };
  };

  const res = await request(app)
    .get('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { frontendEnabled: false },
  });
});

test('GET /api/admin/viral-videos returns admin viral video list', async (t) => {
  stubDbReady(t);

  const prevFind = ViralVideo.find;
  const prevCountDocuments = ViralVideo.countDocuments;
  t.after(() => {
    ViralVideo.find = prevFind;
    ViralVideo.countDocuments = prevCountDocuments;
  });

  ViralVideo.find = () => makeFindResult([{
    _id: '507f1f77bcf86cd799439501',
    title: 'Admin viral clip',
    slug: 'admin-viral-clip',
    summary: 'Short admin summary',
    posterImage: { url: 'https://img.example/admin.jpg', alt: 'Poster' },
    embedUrl: 'https://www.youtube.com/embed/demo',
    sourceType: 'embed',
    language: 'en',
    category: 'news',
    tags: ['viral'],
    isPublished: false,
    isHomepageVisible: true,
    isFeatured: false,
    publishedAt: null,
    sortOrder: 0,
  }]);
  ViralVideo.countDocuments = async () => 1;

  const res = await request(app)
    .get('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].slug, 'admin-viral-clip');
});

test('GET /admin-api/viral-videos aliases admin viral video list for proxy builds', async (t) => {
  stubDbReady(t);

  const prevFind = ViralVideo.find;
  const prevCountDocuments = ViralVideo.countDocuments;
  t.after(() => {
    ViralVideo.find = prevFind;
    ViralVideo.countDocuments = prevCountDocuments;
  });

  ViralVideo.find = () => makeFindResult([]);
  ViralVideo.countDocuments = async () => 0;

  const res = await request(app)
    .get('/admin-api/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.items, []);
});

test('POST /api/admin/viral-videos/upload-video accepts webm uploads through the media-library storage flow', async (t) => {
  stubDbReady(t);

  const prevUploadMediaLibraryFile = mediaLibraryStorage.uploadMediaLibraryFile;
  const prevCreateIndexedMediaRecord = mediaLibraryService.createIndexedMediaRecord;

  t.after(() => {
    mediaLibraryStorage.uploadMediaLibraryFile = prevUploadMediaLibraryFile;
    mediaLibraryService.createIndexedMediaRecord = prevCreateIndexedMediaRecord;
  });

  mediaLibraryStorage.uploadMediaLibraryFile = async (_req, file) => ({
    id: 'media-storage-1',
    fileName: 'viral-video.webm',
    name: file.originalname,
    mimeType: file.mimetype,
    provider: 'local-disk',
    relativeUrl: '/uploads/media-library/viral-video.webm',
    url: 'http://localhost:5052/uploads/media-library/viral-video.webm',
    size: file.size,
  });

  mediaLibraryService.createIndexedMediaRecord = async (_req, uploaded, options) => ({
    id: 'media-record-1',
    storageId: uploaded.id,
    fileName: uploaded.fileName,
    originalName: uploaded.name,
    mimeType: uploaded.mimeType,
    mediaType: options.mediaType,
    provider: uploaded.provider,
    relativeUrl: uploaded.relativeUrl,
    assetUrl: uploaded.url,
    playbackUrl: uploaded.url,
    url: uploaded.url,
    size: uploaded.size,
  });

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('webmdata'), { filename: 'clip.webm', contentType: 'video/webm' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.uploadedVideo.mimeType, 'video/webm');
  assert.equal(res.body.uploadedVideo.provider, 'local-disk');
  assert.equal(res.body.media.mediaType, 'video');
});

test('POST /api/admin/viral-videos/upload-video rejects unsupported video types', async (t) => {
  stubDbReady(t);

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.avi', contentType: 'video/x-msvideo' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Only JPG, JPEG, PNG images and MP4, MOV, WEBM videos are allowed.');
});