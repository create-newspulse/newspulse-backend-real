const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const cloudinary = require('../lib/cloudinary');
const Media = require('../models/Media');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function stubCloudinaryUpload(t, handler) {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;

  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: true,
    mode: 'keys',
    missing: [],
    cloudinaryUrlValid: null,
    env: { cloudNamePresent: true, apiKeyPresent: true, apiSecretPresent: true, cloudinaryUrlPresent: false },
  });
  cloudinary.uploadFromBuffer = handler;

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
  });
}

function stubMediaIndex(t) {
  const prevCreate = Media.create;
  const prevFindById = Media.findById;
  const store = new Map();

  Media.create = async (payload) => {
    const doc = { _id: new mongoose.Types.ObjectId(), ...payload, createdAt: new Date(), updatedAt: new Date() };
    store.set(String(doc._id), doc);
    return doc;
  };
  Media.findById = (id) => ({
    async lean() {
      return store.get(String(id)) || null;
    },
  });

  t.after(() => {
    Media.create = prevCreate;
    Media.findById = prevFindById;
  });
}

test('POST /api/live-tv/upload-offline-poster uploads WEBP poster through Media Library', async (t) => {
  stubMediaIndex(t);
  stubCloudinaryUpload(t, async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(options.resourceType, 'image');
    return {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/live-tv/offline-poster.webp',
      public_id: 'newspulse/media-library/offline-poster',
      bytes: 2048,
    };
  });

  const res = await request(app)
    .post('/api/live-tv/upload-offline-poster')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('offlinePosterImage', Buffer.from('webpdata'), { filename: 'poster.webp', contentType: 'image/webp' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.url, 'https://res.cloudinary.com/demo/image/upload/live-tv/offline-poster.webp');
  assert.equal(res.body.data.field, 'offlinePosterImageUrl');
  assert.equal(res.body.data.media.source, 'live-tv-offline-poster');
  assert.equal(res.body.data.media.mediaType, 'image');
  assert.equal(res.body.data.media.mimeType, 'image/webp');
});

test('POST /api/live-tv/upload-offline-video uploads WEBM loop through Media Library', async (t) => {
  stubMediaIndex(t);
  stubCloudinaryUpload(t, async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(options.resourceType, 'video');
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/live-tv/offline-loop.webm',
      public_id: 'newspulse/media-library/offline-loop',
      bytes: 4096,
    };
  });

  const res = await request(app)
    .post('/api/live-tv/upload-offline-video')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('offlineLoopVideo', Buffer.from('webmdata'), { filename: 'loop.webm', contentType: 'video/webm' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.url, 'https://res.cloudinary.com/demo/video/upload/live-tv/offline-loop.webm');
  assert.equal(res.body.data.field, 'offlineLoopVideoUrl');
  assert.equal(res.body.data.media.source, 'live-tv-offline-loop-video');
  assert.equal(res.body.data.media.mediaType, 'video');
  assert.equal(res.body.data.media.mimeType, 'video/webm');
});

test('Live TV offline upload rejects unsupported and empty files cleanly', async () => {
  const token = makeOpaqueAdminToken();

  const unsupported = await request(app)
    .post('/api/live-tv/upload-offline-poster')
    .set('Authorization', `Bearer ${token}`)
    .attach('offlinePosterImage', Buffer.from('gif89a'), { filename: 'poster.gif', contentType: 'image/gif' });

  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.success, false);
  assert.equal(unsupported.body.message, 'Only JPG, JPEG, PNG, and WEBP images are allowed for Live TV offline poster uploads.');

  const empty = await request(app)
    .post('/api/live-tv/upload-offline-video')
    .set('Authorization', `Bearer ${token}`)
    .attach('offlineLoopVideo', Buffer.alloc(0), { filename: 'empty.mp4', contentType: 'video/mp4' });

  assert.equal(empty.status, 400);
  assert.equal(empty.body.success, false);
  assert.equal(empty.body.message, 'Uploaded file is empty');
});