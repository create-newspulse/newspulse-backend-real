const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const ViralVideo = require('../models/ViralVideo');
const cloudinary = require('../lib/cloudinary');
const { VIRAL_VIDEOS_SETTINGS_KEY } = require('../lib/viralVideosSettings');

const CLOUD_VIDEO_NOT_CONNECTED_MESSAGE = 'Cloud video upload is not connected yet. Use Video URL for now.';
const CLOUD_VIDEO_DISABLED_MESSAGE = 'Cloud video upload is available but disabled. Use Video URL unless enabled.';
const CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE = 'Cloudinary video upload is not configured on backend.';
const CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE = 'Cloudinary video upload failed.';
const IMAGE_UPLOAD_NOT_CONFIGURED_MESSAGE = 'Image upload is not configured in this environment. Paste an image URL to continue.';
const THUMBNAIL_IMAGE_TYPE_NOT_ALLOWED_MESSAGE = 'Only JPG, JPEG, PNG, or WEBP thumbnail images are allowed.';

function missingCloudUploadCapability(enabled = false) {
  return {
    enabled,
    available: false,
    provider: null,
    message: CLOUD_VIDEO_NOT_CONNECTED_MESSAGE,
  };
}

function configuredCloudUploadCapability(enabled = false) {
  return {
    enabled,
    available: true,
    provider: 'cloudinary',
    message: enabled
      ? 'Cloud video upload is ready.'
      : CLOUD_VIDEO_DISABLED_MESSAGE,
  };
}

function stubCloudinaryConfig(t, configured) {
  const prevCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const prevApiKey = process.env.CLOUDINARY_API_KEY;
  const prevApiSecret = process.env.CLOUDINARY_API_SECRET;
  const prevCloudinaryUrl = process.env.CLOUDINARY_URL;
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    if (prevCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME; else process.env.CLOUDINARY_CLOUD_NAME = prevCloudName;
    if (prevApiKey === undefined) delete process.env.CLOUDINARY_API_KEY; else process.env.CLOUDINARY_API_KEY = prevApiKey;
    if (prevApiSecret === undefined) delete process.env.CLOUDINARY_API_SECRET; else process.env.CLOUDINARY_API_SECRET = prevApiSecret;
    if (prevCloudinaryUrl === undefined) delete process.env.CLOUDINARY_URL; else process.env.CLOUDINARY_URL = prevCloudinaryUrl;
  });
  if (configured) {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    process.env.CLOUDINARY_API_KEY = 'key';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    delete process.env.CLOUDINARY_URL;
  } else {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    delete process.env.CLOUDINARY_URL;
  }
  cloudinary.getCloudinaryConfigStatus = () => ({
    configured,
    mode: configured ? 'keys' : 'missing',
    cloudinaryUrlValid: null,
    missing: configured ? [] : ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_URL'],
    env: {
      cloudNamePresent: configured,
      apiKeyPresent: configured,
      apiSecretPresent: configured,
      cloudinaryUrlPresent: false,
    },
  });
}

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeExpiredAdminJwt() {
  return jwt.sign({ sub: 'admin-id', email: 'admin@newspulse.ai', role: 'admin' }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: -60 });
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
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  t.after(() => { SystemSetting.findOne = prevFindOne; });

  SystemSetting.findOne = () => ({ lean: async () => null });

  const res = await request(app)
    .get('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { viralVideosFrontendEnabled: true, frontendEnabled: true, viralVideosCloudUploadEnabled: false, viralVideosCloudUploadAvailable: false, viralVideosCloudUpload: missingCloudUploadCapability(false) },
    viralVideosCloudUploadEnabled: false,
    viralVideosCloudUploadAvailable: false,
    viralVideosCloudUpload: missingCloudUploadCapability(false),
  });
});

test('GET /api/admin/viral-videos/settings reports cloudinary availability when configured', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  t.after(() => { SystemSetting.findOne = prevFindOne; });

  SystemSetting.findOne = () => ({ lean: async () => null });

  const res = await request(app)
    .get('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.viralVideosCloudUploadEnabled, false);
  assert.equal(res.body.viralVideosCloudUploadAvailable, true);
  assert.equal(res.body.settings.viralVideosCloudUploadAvailable, true);
  assert.deepEqual(res.body.viralVideosCloudUpload, configuredCloudUploadCapability(false));
  assert.deepEqual(res.body.settings.viralVideosCloudUpload, configuredCloudUploadCapability(false));
});

test('PUT /api/admin/viral-videos/settings persists frontendEnabled false in isolated SystemSetting', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  let capturedFilter = null;
  let capturedUpdate = null;
  let capturedOptions = null;

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { viralVideosFrontendEnabled: true, frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
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
    settings: { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false, viralVideosCloudUploadAvailable: false, viralVideosCloudUpload: missingCloudUploadCapability(false) },
    viralVideosCloudUploadEnabled: false,
    viralVideosCloudUploadAvailable: false,
    viralVideosCloudUpload: missingCloudUploadCapability(false),
  });
  assert.deepEqual(capturedFilter, { key: VIRAL_VIDEOS_SETTINGS_KEY });
  assert.deepEqual(capturedUpdate.$set.value, { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false });
  assert.equal(capturedUpdate.$set.key, VIRAL_VIDEOS_SETTINGS_KEY);
  assert.deepEqual(capturedOptions, { upsert: true, new: true });
});

test('PUT /api/admin/viral-videos/settings persists viralVideosFrontendEnabled false', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  let capturedUpdate = null;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { viralVideosFrontendEnabled: true, frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
  SystemSetting.findOneAndUpdate = (_filter, update) => {
    capturedUpdate = update;
    return { lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: update.$set.value }) };
  };

  const res = await request(app)
    .put('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ viralVideosFrontendEnabled: false });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false, viralVideosCloudUploadAvailable: false, viralVideosCloudUpload: missingCloudUploadCapability(false) },
    viralVideosCloudUploadEnabled: false,
    viralVideosCloudUploadAvailable: false,
    viralVideosCloudUpload: missingCloudUploadCapability(false),
  });
  assert.deepEqual(capturedUpdate.$set.value, { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false });
});

test('PUT /api/admin/viral-videos/settings persists cloud upload flag without changing frontend visibility', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  let capturedUpdate = null;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false } }) });
  SystemSetting.findOneAndUpdate = (_filter, update) => {
    capturedUpdate = update;
    return { lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: update.$set.value }) };
  };

  const res = await request(app)
    .put('/api/admin/viral-videos/settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ viralVideosCloudUploadEnabled: true });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: true, viralVideosCloudUploadAvailable: true, viralVideosCloudUpload: configuredCloudUploadCapability(true) },
    viralVideosCloudUploadEnabled: true,
    viralVideosCloudUploadAvailable: true,
    viralVideosCloudUpload: configuredCloudUploadCapability(true),
  });
  assert.deepEqual(capturedUpdate.$set.value, { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: true });
});

test('GET /api/admin/viral-videos/settings returns saved frontendEnabled false', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

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
    settings: { viralVideosFrontendEnabled: false, frontendEnabled: false, viralVideosCloudUploadEnabled: false, viralVideosCloudUploadAvailable: false, viralVideosCloudUpload: missingCloudUploadCapability(false) },
    viralVideosCloudUploadEnabled: false,
    viralVideosCloudUploadAvailable: false,
    viralVideosCloudUpload: missingCloudUploadCapability(false),
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
    sourceName: 'News Pulse',
    posterImage: { url: 'https://img.example/admin.jpg', alt: 'Poster' },
    embedUrl: 'https://www.youtube.com/embed/demo',
    sourceType: 'embed',
    language: 'en',
    category: 'news',
    tags: ['viral'],
    isPublished: false,
    isActive: true,
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
  assert.equal(res.body.items[0].sourceName, 'News Pulse');
  assert.equal(res.body.items[0].isActive, true);
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

test('POST /api/admin/viral-videos saves thumbnailUrl and videoUrl without uploaded video metadata', async (t) => {
  stubDbReady(t);

  const prevCreate = ViralVideo.create;
  t.after(() => { ViralVideo.create = prevCreate; });

  let capturedPayload = null;
  ViralVideo.create = async (payload) => {
    capturedPayload = payload;
    return {
      _id: '507f1f77bcf86cd799439502',
      ...payload,
      createdAt: new Date('2026-04-30T08:00:00.000Z'),
      updatedAt: new Date('2026-04-30T08:00:00.000Z'),
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      title: 'URL-only viral clip',
      slug: 'url-only-viral-clip',
      summary: 'A clip with image thumbnail and video URL',
      language: 'en',
      sourceName: 'News Pulse',
      category: 'news',
      thumbnailUrl: 'https://res.cloudinary.com/demo/image/upload/thumb.jpg',
      videoUrl: 'https://cdn.example.com/videos/clip.mp4',
      sourceType: 'url',
      isActive: true,
      status: 'draft',
      showOnHomepage: true,
      priority: 7,
      uploadedVideo: { url: 'https://cdn.example.com/should-not-save.mp4' },
    });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.thumbnailUrl, 'https://res.cloudinary.com/demo/image/upload/thumb.jpg');
  assert.equal(res.body.item.posterImageUrl, 'https://res.cloudinary.com/demo/image/upload/thumb.jpg');
  assert.equal(res.body.item.videoUrl, 'https://cdn.example.com/videos/clip.mp4');
  assert.equal(res.body.item.videoFileUrl, 'https://cdn.example.com/videos/clip.mp4');
  assert.equal(res.body.item.sourceName, 'News Pulse');
  assert.equal(res.body.item.isActive, true);
  assert.equal(res.body.item.sourceType, 'upload');
  assert.equal(res.body.item.videoType, 'uploaded');
  assert.equal(res.body.item.playbackMode, 'internal');
  assert.equal(res.body.item.showOnHomepage, true);
  assert.equal(res.body.item.priority, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedPayload, 'uploadedVideo'), false);
  assert.equal(capturedPayload.posterImageUrl, 'https://res.cloudinary.com/demo/image/upload/thumb.jpg');
  assert.equal(capturedPayload.videoFileUrl, 'https://cdn.example.com/videos/clip.mp4');
});

test('POST /api/admin/viral-videos publishes Gujarati video with thumbnail fields for public API', async (t) => {
  stubDbReady(t);

  const prevCreate = ViralVideo.create;
  t.after(() => { ViralVideo.create = prevCreate; });

  let capturedPayload = null;
  ViralVideo.create = async (payload) => {
    capturedPayload = payload;
    return {
      _id: '507f1f77bcf86cd799439503',
      slug: 'gujarati-short-video',
      ...payload,
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
      updatedAt: new Date('2026-05-01T08:00:00.000Z'),
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      title: 'Gujarati short video',
      language: 'gu',
      sourceName: 'Divya Bhaskar',
      thumbnailUrl: 'https://img.example.com/gujarati-short.jpg',
      videoUrl: 'https://cdn.example.com/videos/gujarati-short.mp4',
      status: 'published',
      isActive: true,
    });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.language, 'gu');
  assert.equal(res.body.item.status, 'published');
  assert.equal(res.body.item.isPublished, true);
  assert.equal(res.body.item.isActive, true);
  assert.equal(res.body.item.sourceName, 'Divya Bhaskar');
  assert.equal(res.body.item.thumbnailUrl, 'https://img.example.com/gujarati-short.jpg');
  assert.equal(res.body.item.posterImageUrl, 'https://img.example.com/gujarati-short.jpg');
  assert.equal(res.body.item.posterImage.url, 'https://img.example.com/gujarati-short.jpg');
  assert.equal(res.body.item.videoType, 'uploaded');
  assert.equal(res.body.item.playbackMode, 'internal');
  assert.ok(capturedPayload.publishedAt instanceof Date);
});

test('POST /api/admin/viral-videos saves external source pages as external playback', async (t) => {
  stubDbReady(t);

  const prevCreate = ViralVideo.create;
  t.after(() => { ViralVideo.create = prevCreate; });

  let capturedPayload = null;
  ViralVideo.create = async (payload) => {
    capturedPayload = payload;
    return {
      _id: '507f1f77bcf86cd799439504',
      ...payload,
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
      updatedAt: new Date('2026-05-01T08:00:00.000Z'),
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      title: 'External viral source',
      slug: 'external-viral-source',
      language: 'en',
      sourceName: 'Instagram',
      thumbnailUrl: 'https://img.example.com/external.jpg',
      videoUrl: 'https://www.instagram.com/reel/demo/',
      status: 'published',
      isActive: true,
    });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.videoType, 'external');
  assert.equal(res.body.item.playbackMode, 'external');
  assert.equal(res.body.item.sourceType, 'url');
  assert.equal(res.body.item.sourceUrl, 'https://www.instagram.com/reel/demo/');
  assert.equal(capturedPayload.videoType, 'external');
  assert.equal(capturedPayload.playbackMode, 'external');
  assert.equal(capturedPayload.sourceUrl, 'https://www.instagram.com/reel/demo/');
});

test('POST /api/admin/viral-videos saves X status URLs as X embed playback', async (t) => {
  stubDbReady(t);

  const prevCreate = ViralVideo.create;
  t.after(() => { ViralVideo.create = prevCreate; });

  let capturedPayload = null;
  ViralVideo.create = async (payload) => {
    capturedPayload = payload;
    return {
      _id: '507f1f77bcf86cd799439505',
      ...payload,
      createdAt: new Date('2026-05-01T08:00:00.000Z'),
      updatedAt: new Date('2026-05-01T08:00:00.000Z'),
    };
  };

  const xUrl = 'https://x.com/i/status/2050104453630718079';
  const res = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      title: 'X viral status',
      slug: 'x-viral-status',
      language: 'en',
      thumbnailUrl: 'https://img.example.com/x-status.jpg',
      posterImageUrl: 'https://img.example.com/x-status.jpg',
      videoUrl: xUrl,
      status: 'published',
      isActive: true,
    });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.videoType, 'x');
  assert.equal(res.body.item.playbackMode, 'x_embed');
  assert.equal(res.body.item.videoUrl, xUrl);
  assert.equal(res.body.item.sourceUrl, xUrl);
  assert.equal(res.body.item.sourceName, 'X');
  assert.equal(res.body.item.videoFileUrl, null);
  assert.equal(res.body.item.thumbnailUrl, 'https://img.example.com/x-status.jpg');
  assert.equal(res.body.item.posterImageUrl, 'https://img.example.com/x-status.jpg');
  assert.equal(capturedPayload.videoType, 'x');
  assert.equal(capturedPayload.playbackMode, 'x_embed');
  assert.equal(capturedPayload.videoUrl, xUrl);
  assert.equal(capturedPayload.sourceUrl, xUrl);
  assert.equal(capturedPayload.sourceName, 'X');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedPayload, 'videoFileUrl'), false);
});

test('POST /api/admin/viral-videos/upload-thumbnail saves thumbnail images through existing cover image storage', async (t) => {
  stubDbReady(t);

  const prevIsCloudinaryConfigured = cloudinary.isCloudinaryConfigured;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevUploadFromDataUri = cloudinary.uploadFromDataUri;

  t.after(() => {
    cloudinary.isCloudinaryConfigured = prevIsCloudinaryConfigured;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    cloudinary.uploadFromDataUri = prevUploadFromDataUri;
  });

  cloudinary.isCloudinaryConfigured = () => true;
  cloudinary.uploadFromDataUri = async () => { throw new Error('data uri fallback should not be used'); };
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(options.folder, 'newspulse/articles');
    return {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/viral-thumb.jpg',
      public_id: 'newspulse/articles/viral-thumb',
      width: 640,
      height: 360,
      format: 'jpg',
      bytes: 1234,
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-thumbnail')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('thumbnail', Buffer.from('jpgdata'), { filename: 'thumb.jpg', contentType: 'image/jpeg' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.thumbnailUrl, 'https://res.cloudinary.com/demo/image/upload/viral-thumb.jpg');
  assert.deepEqual(res.body.posterImage, {
    url: 'https://res.cloudinary.com/demo/image/upload/viral-thumb.jpg',
    publicId: 'newspulse/articles/viral-thumb',
    alt: null,
  });
  assert.equal(res.body.data.publicId, 'newspulse/articles/viral-thumb');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'uploadedVideo'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'media'), false);
});

test('POST /api/admin/viral-videos/thumbnail-upload accepts webp thumbnail alias without route miss', async (t) => {
  stubDbReady(t);

  const prevIsCloudinaryConfigured = cloudinary.isCloudinaryConfigured;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevUploadFromDataUri = cloudinary.uploadFromDataUri;

  t.after(() => {
    cloudinary.isCloudinaryConfigured = prevIsCloudinaryConfigured;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    cloudinary.uploadFromDataUri = prevUploadFromDataUri;
  });

  cloudinary.isCloudinaryConfigured = () => true;
  cloudinary.uploadFromDataUri = async () => { throw new Error('data uri fallback should not be used'); };
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(options.folder, 'newspulse/articles');
    return {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/viral-thumb.webp',
      public_id: 'newspulse/articles/viral-thumb-webp',
      width: 640,
      height: 360,
      format: 'webp',
      bytes: 987,
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/thumbnail-upload')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('thumbnail', Buffer.from('webpdata'), { filename: 'thumb.webp', contentType: 'image/webp' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.thumbnailUrl, 'https://res.cloudinary.com/demo/image/upload/viral-thumb.webp');
  assert.equal(res.body.data.format, 'webp');
  assert.notEqual(res.body.message, 'Route not found');
});

test('POST /admin-api/viral-videos/upload/image returns thumbnail-specific wrong file type message', async (t) => {
  stubDbReady(t);

  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => { cloudinary.uploadFromBuffer = prevUploadFromBuffer; });

  let uploadCalled = false;
  cloudinary.uploadFromBuffer = async () => {
    uploadCalled = true;
    throw new Error('upload should not run for invalid thumbnail type');
  };

  const res = await request(app)
    .post('/admin-api/viral-videos/upload/image')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('thumbnail', Buffer.from('gif89a'), { filename: 'thumb.gif', contentType: 'image/gif' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'MEDIA_TYPE_NOT_ALLOWED');
  assert.equal(res.body.message, THUMBNAIL_IMAGE_TYPE_NOT_ALLOWED_MESSAGE);
  assert.notEqual(res.body.message, 'Route not found');
  assert.equal(uploadCalled, false);
});

test('POST /api/admin/viral-videos/upload-thumbnail returns clear missing image upload env message', async (t) => {
  stubDbReady(t);

  const prevIsCloudinaryConfigured = cloudinary.isCloudinaryConfigured;
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    cloudinary.isCloudinaryConfigured = prevIsCloudinaryConfigured;
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let uploadCalled = false;
  cloudinary.isCloudinaryConfigured = () => false;
  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: false,
    mode: 'missing',
    cloudinaryUrlValid: null,
    missing: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_URL'],
    env: {
      cloudNamePresent: false,
      apiKeyPresent: false,
      apiSecretPresent: false,
      cloudinaryUrlPresent: false,
    },
  });
  cloudinary.uploadFromBuffer = async () => {
    uploadCalled = true;
    throw new Error('upload should not run when Cloudinary is not configured');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-thumbnail')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('thumbnail', Buffer.from('jpgdata'), { filename: 'thumb.jpg', contentType: 'image/jpeg' });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, IMAGE_UPLOAD_NOT_CONFIGURED_MESSAGE);
  assert.equal(uploadCalled, false);
});

test('POST /api/admin/viral-videos/upload routes MP4 to video upload flow', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.resourceType, 'video');
    assert.equal(options.folder, 'newspulse/viral-videos');
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/viral-alias.mp4',
      public_id: 'newspulse/viral-videos/viral-alias',
      resource_type: 'video',
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.videoFileUrl, 'https://res.cloudinary.com/demo/video/upload/viral-alias.mp4');
  assert.equal(res.body.resource_type, 'video');
  assert.equal(res.body.message, 'Cloud video upload is ready.');
});

test('POST /api/admin/viral-videos/upload keeps thumbnail upload working for image files', async (t) => {
  stubDbReady(t);

  const prevIsCloudinaryConfigured = cloudinary.isCloudinaryConfigured;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevUploadFromDataUri = cloudinary.uploadFromDataUri;

  t.after(() => {
    cloudinary.isCloudinaryConfigured = prevIsCloudinaryConfigured;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    cloudinary.uploadFromDataUri = prevUploadFromDataUri;
  });

  cloudinary.isCloudinaryConfigured = () => true;
  cloudinary.uploadFromDataUri = async () => { throw new Error('data uri fallback should not be used'); };
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.folder, 'newspulse/articles');
    return {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/viral-alias-thumb.jpg',
      public_id: 'newspulse/articles/viral-alias-thumb',
      format: 'jpg',
      bytes: 1200,
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('thumbnail', Buffer.from('jpgdata'), { filename: 'thumb.jpg', contentType: 'image/jpeg' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.thumbnailUrl, 'https://res.cloudinary.com/demo/image/upload/viral-alias-thumb.jpg');
  assert.deepEqual(res.body.posterImage, {
    url: 'https://res.cloudinary.com/demo/image/upload/viral-alias-thumb.jpg',
    publicId: 'newspulse/articles/viral-alias-thumb',
    alt: null,
  });
});

test('POST /api/admin/viral-videos/upload-video rejects video files', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called for video files while cloud upload is disabled');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CLOUDINARY_CONFIG_MISSING');
  assert.equal(res.body.provider, 'cloudinary');
  assert.equal(res.body.message, CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, false);
  assert.deepEqual(res.body.viralVideosCloudUpload, missingCloudUploadCapability(false));
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video reports enabled but unavailable cloud upload', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called when video cloud upload is unavailable');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CLOUDINARY_CONFIG_MISSING');
  assert.equal(res.body.provider, 'cloudinary');
  assert.equal(res.body.message, CLOUDINARY_VIDEO_UPLOAD_NOT_CONFIGURED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, false);
  assert.deepEqual(res.body.viralVideosCloudUpload, missingCloudUploadCapability(true));
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video reports configured but disabled cloud upload', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called for disabled video uploads');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.provider, 'cloudinary');
  assert.equal(res.body.message, CLOUD_VIDEO_DISABLED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, true);
  assert.deepEqual(res.body.viralVideosCloudUpload, configuredCloudUploadCapability(false));
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video treats missing upload flag as enabled when Cloudinary is configured', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.resourceType, 'video');
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/viral-missing-flag.mp4',
      public_id: 'newspulse/viral-videos/viral-missing-flag',
      resource_type: 'video',
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.provider, 'cloudinary');
  assert.equal(res.body.message, 'Cloud video upload is ready.');
  assert.equal(res.body.videoFileUrl, 'https://res.cloudinary.com/demo/video/upload/viral-missing-flag.mp4');
  assert.deepEqual(res.body.viralVideosCloudUpload, configuredCloudUploadCapability(true));
});

test('POST /api/admin/viral-videos/upload-video accepts video, videoFile, and file multipart fields', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  const fieldNames = [];
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.equal(buffer.toString('utf8'), 'videodata');
    assert.equal(options.resourceType, 'video');
    const index = fieldNames.length;
    return {
      secure_url: `https://res.cloudinary.com/demo/video/upload/viral-field-${index}.mp4`,
      public_id: `newspulse/viral-videos/viral-field-${index}`,
      resource_type: 'video',
    };
  };

  for (const fieldName of ['video', 'videoFile', 'file']) {
    fieldNames.push(fieldName);
    const res = await request(app)
      .post('/api/admin/viral-videos/upload-video')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .attach(fieldName, Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.videoFileUrl, /^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/viral-field-/);
    assert.equal(res.body.videoMimeType, 'video/mp4');
  }

  assert.deepEqual(fieldNames, ['video', 'videoFile', 'file']);
});

test('POST /admin-api/admin/viral-videos/upload-video reaches Viral Videos upload endpoint', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.equal(buffer.toString('utf8'), 'videodata');
    assert.equal(options.resourceType, 'video');
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/viral-admin-api-alias.mp4',
      public_id: 'newspulse/viral-videos/viral-admin-api-alias',
      resource_type: 'video',
    };
  };

  const res = await request(app)
    .post('/admin-api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.videoFileUrl, 'https://res.cloudinary.com/demo/video/upload/viral-admin-api-alias.mp4');
});

test('POST /api/admin/viral-videos/upload-video returns VIDEO_FILE_MISSING when no file is received', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('upload should not run without a file');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .field('title', 'No video file');

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    code: 'VIDEO_FILE_MISSING',
    message: 'No video file received. Please select an MP4, WebM, or MOV file.',
  });
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video returns ADMIN_AUTH_EXPIRED for expired admin JWT', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let settingsRead = false;
  let cloudinaryCalled = false;
  SystemSetting.findOne = () => {
    settingsRead = true;
    return { lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) };
  };
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('upload should not run for expired admin sessions');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeExpiredAdminJwt()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    ok: false,
    code: 'ADMIN_AUTH_EXPIRED',
    message: 'Admin session expired. Please login again.',
  });
  assert.equal(settingsRead, false);
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video uploads allowed Cloudinary video formats', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  const calls = [];
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString('utf8'), 'videodata');
    calls.push(options);
    const index = calls.length;
    return {
      secure_url: `https://res.cloudinary.com/demo/video/upload/viral-${index}.mp4`,
      url: `http://res.cloudinary.com/demo/video/upload/viral-${index}.mp4`,
      resource_type: 'video',
      public_id: `newspulse/viral-videos/viral-${index}`,
      bytes: buffer.length,
    };
  };

  const cases = [
    { filename: 'clip.mp4', contentType: 'video/mp4' },
    { filename: 'clip.webm', contentType: 'video/webm' },
    { filename: 'clip.mov', contentType: 'video/quicktime' },
  ];

  for (const item of cases) {
    const res = await request(app)
      .post('/api/admin/viral-videos/upload-video')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .attach('video', Buffer.from('videodata'), { filename: item.filename, contentType: item.contentType });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.provider, 'cloudinary');
    assert.equal(res.body.message, 'Cloud video upload is ready.');
    assert.equal(res.body.url, res.body.secure_url);
    assert.match(res.body.url, /^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\//);
    assert.equal(res.body.resource_type, 'video');
    assert.equal(res.body.videoFileUrl, res.body.url);
    assert.equal(res.body.videoStorageProvider, 'cloudinary');
    assert.equal(res.body.videoMimeType, item.contentType);
    assert.deepEqual(res.body.viralVideosCloudUpload, configuredCloudUploadCapability(true));
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.resourceType), ['video', 'video', 'video']);
  assert.deepEqual(calls.map((call) => call.folder), ['newspulse/viral-videos', 'newspulse/viral-videos', 'newspulse/viral-videos']);
});

test('POST /api/admin/viral-videos/upload-video rejects unsafe video MIME or extension', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('upload should not run for invalid video files');
  };

  const cases = [
    { filename: 'clip.avi', contentType: 'video/mp4' },
    { filename: 'clip.mp4', contentType: 'application/octet-stream' },
  ];

  for (const item of cases) {
    const res = await request(app)
      .post('/api/admin/viral-videos/upload-video')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .attach('video', Buffer.from('videodata'), { filename: item.filename, contentType: item.contentType });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'INVALID_VIDEO_TYPE');
    assert.equal(res.body.message, 'Only MP4, WebM, or MOV videos are allowed.');
  }

  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video returns clear Cloudinary failure JSON', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.resourceType, 'video');
    const err = new Error('Cloudinary rejected the upload: secret');
    err.http_code = 500;
    err.code = 'cloudinary_reject';
    throw err;
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    code: 'CLOUDINARY_UPLOAD_FAILED',
    message: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Cloudinary rejected the upload: [redacted]`,
    providerMessage: 'Cloudinary rejected the upload: [redacted]',
    error: 'Cloudinary rejected the upload: [redacted]',
    errorMessage: 'Cloudinary rejected the upload: [redacted]',
    reason: 'Cloudinary rejected the upload: [redacted]',
    userMessage: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Cloudinary rejected the upload: [redacted]`,
    displayMessage: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Cloudinary rejected the upload: [redacted]`,
    cloudinaryError: 'Cloudinary rejected the upload: [redacted]',
    providerError: 'Cloudinary rejected the upload: [redacted]',
    details: {
      providerMessage: 'Cloudinary rejected the upload: [redacted]',
    },
  });
});

test('POST /api/admin/viral-videos/upload-video returns nested safe Cloudinary provider message', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.resourceType, 'video');
    const err = new Error('Cloudinary upload request failed');
    err.name = 'CloudinaryError';
    err.http_code = 400;
    err.error = { message: 'Invalid video file: secret' };
    throw err;
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    code: 'CLOUDINARY_UPLOAD_FAILED',
    message: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Invalid video file: [redacted]`,
    providerMessage: 'Invalid video file: [redacted]',
    error: 'Invalid video file: [redacted]',
    errorMessage: 'Invalid video file: [redacted]',
    reason: 'Invalid video file: [redacted]',
    userMessage: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Invalid video file: [redacted]`,
    displayMessage: `${CLOUDINARY_VIDEO_UPLOAD_FAILED_MESSAGE} Invalid video file: [redacted]`,
    cloudinaryError: 'Invalid video file: [redacted]',
    providerError: 'Invalid video file: [redacted]',
    details: {
      providerMessage: 'Invalid video file: [redacted]',
    },
  });
});

test('POST /api/admin/viral-videos/upload/video aliases to video upload endpoint', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });

  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadFromBuffer = async (_buffer, options) => {
    assert.equal(options.resourceType, 'video');
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/viral-alias-path.mp4',
      public_id: 'newspulse/viral-videos/viral-alias-path',
      resource_type: 'video',
    };
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload/video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('videodata'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.videoFileUrl, 'https://res.cloudinary.com/demo/video/upload/viral-alias-path.mp4');
});

test('GET /api/admin/viral-videos/:id/preview aliases to item fetch', async (t) => {
  stubDbReady(t);

  const prevFindById = ViralVideo.findById;
  t.after(() => { ViralVideo.findById = prevFindById; });

  ViralVideo.findById = () => ({
    lean: async () => ({
      _id: '507f1f77bcf86cd799439521',
      title: 'Preview item',
      slug: 'preview-item',
      summary: 'Preview summary',
      sourceType: 'url',
      isPublished: false,
      isActive: true,
    }),
  });

  const res = await request(app)
    .get('/api/admin/viral-videos/507f1f77bcf86cd799439521/preview')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.slug, 'preview-item');
});

test('PATCH /api/admin/viral-videos/:id/unpublish and publish aliases update status', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = ViralVideo.findOneAndUpdate;
  t.after(() => { ViralVideo.findOneAndUpdate = prevFindOneAndUpdate; });

  const payloads = [];
  ViralVideo.findOneAndUpdate = async (_query, update) => {
    payloads.push(update.$set);
    return {
      _id: '507f1f77bcf86cd799439522',
      title: 'Status item',
      slug: 'status-item',
      ...update.$set,
      createdAt: new Date('2026-05-02T08:00:00.000Z'),
      updatedAt: new Date('2026-05-02T08:00:00.000Z'),
    };
  };

  const unpublishRes = await request(app)
    .patch('/api/admin/viral-videos/507f1f77bcf86cd799439522/unpublish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({});
  assert.equal(unpublishRes.statusCode, 200);
  assert.equal(unpublishRes.body.ok, true);
  assert.equal(unpublishRes.body.item.status, 'draft');
  assert.equal(unpublishRes.body.item.isPublished, false);

  const publishRes = await request(app)
    .patch('/api/admin/viral-videos/507f1f77bcf86cd799439522/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({});
  assert.equal(publishRes.statusCode, 200);
  assert.equal(publishRes.body.ok, true);
  assert.equal(publishRes.body.item.status, 'published');
  assert.equal(publishRes.body.item.isPublished, true);

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].status, 'draft');
  assert.equal(payloads[0].isPublished, false);
  assert.equal(payloads[1].status, 'published');
  assert.equal(payloads[1].isPublished, true);
});

test('PATCH /api/admin/viral-videos/:id/status updates status fields', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = ViralVideo.findOneAndUpdate;
  t.after(() => { ViralVideo.findOneAndUpdate = prevFindOneAndUpdate; });

  const payloads = [];
  ViralVideo.findOneAndUpdate = async (_query, update) => {
    payloads.push(update.$set);
    return {
      _id: '507f1f77bcf86cd799439530',
      title: 'Status route item',
      slug: 'status-route-item',
      ...update.$set,
      createdAt: new Date('2026-05-03T08:00:00.000Z'),
      updatedAt: new Date('2026-05-03T08:00:00.000Z'),
    };
  };

  const res = await request(app)
    .patch('/api/admin/viral-videos/507f1f77bcf86cd799439530/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'published' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.status, 'published');
  assert.equal(res.body.item.isPublished, true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].status, 'published');
});

test('PATCH /api/admin/viral-videos/:id/status updates isActive and isHomepageVisible', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = ViralVideo.findOneAndUpdate;
  t.after(() => { ViralVideo.findOneAndUpdate = prevFindOneAndUpdate; });

  const payloads = [];
  ViralVideo.findOneAndUpdate = async (_query, update) => {
    payloads.push(update.$set);
    return {
      _id: '507f1f77bcf86cd799439531',
      title: 'Status route item 2',
      slug: 'status-route-item-2',
      ...update.$set,
      createdAt: new Date('2026-05-03T08:00:00.000Z'),
      updatedAt: new Date('2026-05-03T08:00:00.000Z'),
    };
  };

  const res = await request(app)
    .patch('/api/admin/viral-videos/507f1f77bcf86cd799439531/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'draft', isActive: false, showOnHomepage: false });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.status, 'draft');
  assert.equal(res.body.item.isPublished, false);
  assert.equal(res.body.item.isActive, false);
  assert.equal(payloads[0].isHomepageVisible, false);
});

test('POST /api/admin/viral-videos/:id/status also works for status update', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = ViralVideo.findOneAndUpdate;
  t.after(() => { ViralVideo.findOneAndUpdate = prevFindOneAndUpdate; });

  ViralVideo.findOneAndUpdate = async (_query, update) => ({
    _id: '507f1f77bcf86cd799439532',
    title: 'Post status item',
    slug: 'post-status-item',
    ...update.$set,
    createdAt: new Date('2026-05-03T08:00:00.000Z'),
    updatedAt: new Date('2026-05-03T08:00:00.000Z'),
  });

  const res = await request(app)
    .post('/api/admin/viral-videos/507f1f77bcf86cd799439532/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'published', showOnHomepage: true });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.status, 'published');
  assert.equal(res.body.item.isHomepageVisible, true);
});

test('PATCH /api/admin/viral-videos/:id/status returns 404 JSON when video not found', async (t) => {
  stubDbReady(t);

  const prevFindOneAndUpdate = ViralVideo.findOneAndUpdate;
  t.after(() => { ViralVideo.findOneAndUpdate = prevFindOneAndUpdate; });

  ViralVideo.findOneAndUpdate = async () => null;

  const res = await request(app)
    .patch('/api/admin/viral-videos/507f1f77bcf86cd799439533/status')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'published' });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Viral video not found');
});

test('GET unknown /api/admin/viral-videos path returns scoped JSON 404', async (t) => {
  stubDbReady(t);

  const res = await request(app)
    .get('/api/admin/viral-videos/not-a-real-endpoint/extra')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Viral Videos admin route not found');
  assert.equal(res.body.method, 'GET');
});
