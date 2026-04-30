const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const ViralVideo = require('../models/ViralVideo');
const cloudinary = require('../lib/cloudinary');
const { VIRAL_VIDEOS_SETTINGS_KEY } = require('../lib/viralVideosSettings');

const CLOUD_VIDEO_NOT_CONNECTED_MESSAGE = 'Cloud video upload is not connected yet. Use Video URL for now.';
const CLOUD_VIDEO_DISABLED_MESSAGE = 'Cloud video upload is available but disabled. Use Video URL unless enabled.';
const IMAGE_UPLOAD_NOT_CONFIGURED_MESSAGE = 'Image upload is not configured in this environment. Paste an image URL to continue.';

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
      ? 'Cloud video upload is enabled but not implemented yet. Use Video URL for now.'
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
      category: 'news',
      thumbnailUrl: 'https://res.cloudinary.com/demo/image/upload/thumb.jpg',
      videoUrl: 'https://cdn.example.com/videos/clip.mp4',
      sourceType: 'url',
      status: 'draft',
      showOnHomepage: true,
      priority: 7,
      uploadedVideo: { url: 'https://cdn.example.com/should-not-save.mp4' },
    });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.thumbnailUrl, 'https://res.cloudinary.com/demo/image/upload/thumb.jpg');
  assert.equal(res.body.item.videoUrl, 'https://cdn.example.com/videos/clip.mp4');
  assert.equal(res.body.item.sourceType, 'url');
  assert.equal(res.body.item.showOnHomepage, true);
  assert.equal(res.body.item.priority, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedPayload, 'uploadedVideo'), false);
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

test('POST /api/admin/viral-videos/upload-video rejects video files', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadCoverImageBuffer = cloudinary.uploadCoverImageBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadCoverImageBuffer = prevUploadCoverImageBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
  cloudinary.uploadCoverImageBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called for video files while cloud upload is disabled');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, CLOUD_VIDEO_NOT_CONNECTED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, false);
  assert.deepEqual(res.body.viralVideosCloudUpload, missingCloudUploadCapability(false));
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video reports enabled but unavailable cloud upload', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, false);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadCoverImageBuffer = cloudinary.uploadCoverImageBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadCoverImageBuffer = prevUploadCoverImageBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: true } }) });
  cloudinary.uploadCoverImageBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called when video cloud upload is unavailable');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, CLOUD_VIDEO_NOT_CONNECTED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, false);
  assert.deepEqual(res.body.viralVideosCloudUpload, missingCloudUploadCapability(true));
  assert.equal(cloudinaryCalled, false);
});

test('POST /api/admin/viral-videos/upload-video reports configured but disabled cloud upload', async (t) => {
  stubDbReady(t);
  stubCloudinaryConfig(t, true);

  const prevFindOne = SystemSetting.findOne;
  const prevUploadCoverImageBuffer = cloudinary.uploadCoverImageBuffer;
  t.after(() => {
    SystemSetting.findOne = prevFindOne;
    cloudinary.uploadCoverImageBuffer = prevUploadCoverImageBuffer;
  });

  let cloudinaryCalled = false;
  SystemSetting.findOne = () => ({ lean: async () => ({ key: VIRAL_VIDEOS_SETTINGS_KEY, value: { frontendEnabled: true, viralVideosCloudUploadEnabled: false } }) });
  cloudinary.uploadCoverImageBuffer = async () => {
    cloudinaryCalled = true;
    throw new Error('cloudinary should not be called for disabled video uploads');
  };

  const res = await request(app)
    .post('/api/admin/viral-videos/upload-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('video', Buffer.from('bad'), { filename: 'clip.mp4', contentType: 'video/mp4' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, CLOUD_VIDEO_DISABLED_MESSAGE);
  assert.equal(res.body.viralVideosCloudUploadAvailable, true);
  assert.deepEqual(res.body.viralVideosCloudUpload, configuredCloudUploadCapability(false));
  assert.equal(cloudinaryCalled, false);
});
