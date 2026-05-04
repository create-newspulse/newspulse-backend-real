const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');
const cloudinary = require('../lib/cloudinary');
const { uploadMediaLibraryFile } = require('../lib/mediaLibraryStorage');
const Media = require('../models/Media');
const {
  ADMIN_MEDIA_ACCEPTED_MIME_TYPES,
  ARTICLE_COVER_ACCEPTED_MIME_TYPES,
  MEDIA_TYPE_NOT_ALLOWED_CODE,
  MEDIA_TYPE_NOT_ALLOWED_MESSAGE,
} = require('../lib/mediaUploadValidation');
const { deriveMediaType, syncCloudinaryMediaLibrary } = require('../services/mediaLibraryService');

async function loginAsAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '').trim();

  const res = await request(app)
    .post('/admin-api/admin/login')
    .send({ email, password })
    .set('Accept', 'application/json');

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'expected admin login token');
  return res.body.token;
}

test('accepted MIME type constants match required admin media formats', () => {
  assert.deepEqual(ADMIN_MEDIA_ACCEPTED_MIME_TYPES, ['image/jpeg', 'image/png', 'video/mp4']);
  assert.deepEqual(ARTICLE_COVER_ACCEPTED_MIME_TYPES, ['image/jpeg', 'image/png', 'image/webp']);
});

test('deriveMediaType stores image uploads as image and mp4 uploads as video', () => {
  assert.equal(deriveMediaType('image/jpeg'), 'image');
  assert.equal(deriveMediaType('image/png'), 'image');
  assert.equal(deriveMediaType('video/mp4'), 'video');
});

test('Media Library image uploads use Cloudinary image resource and secure URL', async (t) => {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevCloudinaryFolder = process.env.CLOUDINARY_FOLDER;
  const prevCloudinaryMediaFolder = process.env.CLOUDINARY_MEDIA_FOLDER;

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    if (prevCloudinaryFolder === undefined) delete process.env.CLOUDINARY_FOLDER;
    else process.env.CLOUDINARY_FOLDER = prevCloudinaryFolder;
    if (prevCloudinaryMediaFolder === undefined) delete process.env.CLOUDINARY_MEDIA_FOLDER;
    else process.env.CLOUDINARY_MEDIA_FOLDER = prevCloudinaryMediaFolder;
  });

  process.env.CLOUDINARY_FOLDER = 'newspulse/media-library';
  delete process.env.CLOUDINARY_MEDIA_FOLDER;
  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: true,
    mode: 'keys',
    missing: [],
    cloudinaryUrlValid: null,
    env: { cloudNamePresent: true, apiKeyPresent: true, apiSecretPresent: true, cloudinaryUrlPresent: false },
  });
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(options, { folder: 'newspulse/media-library', resourceType: 'image' });
    return {
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v123/newspulse/media-library/photo.jpg',
      public_id: 'newspulse/media-library/photo',
      bytes: 4321,
    };
  };

  const uploaded = await uploadMediaLibraryFile({ headers: {}, protocol: 'http', get: () => 'localhost:5000' }, {
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 1234,
    buffer: Buffer.from('jpgdata'),
  });

  assert.equal(uploaded.provider, 'cloudinary');
  assert.equal(uploaded.storageProvider, 'CLOUDINARY');
  assert.equal(uploaded.url, 'https://res.cloudinary.com/demo/image/upload/v123/newspulse/media-library/photo.jpg');
  assert.equal(uploaded.assetUrl, uploaded.url);
  assert.equal(uploaded.thumbnailUrl, uploaded.url);
  assert.equal(uploaded.relativeUrl, null);
  assert.equal(uploaded.mimeType, 'image/jpeg');
  assert.equal(uploaded.size, 4321);
});

test('Media Library video uploads use Cloudinary video resource and derive poster URL', async (t) => {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevCloudinaryFolder = process.env.CLOUDINARY_FOLDER;
  const prevCloudinaryMediaFolder = process.env.CLOUDINARY_MEDIA_FOLDER;

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    if (prevCloudinaryFolder === undefined) delete process.env.CLOUDINARY_FOLDER;
    else process.env.CLOUDINARY_FOLDER = prevCloudinaryFolder;
    if (prevCloudinaryMediaFolder === undefined) delete process.env.CLOUDINARY_MEDIA_FOLDER;
    else process.env.CLOUDINARY_MEDIA_FOLDER = prevCloudinaryMediaFolder;
  });

  process.env.CLOUDINARY_FOLDER = 'newspulse/media-library';
  delete process.env.CLOUDINARY_MEDIA_FOLDER;
  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: true,
    mode: 'keys',
    missing: [],
    cloudinaryUrlValid: null,
    env: { cloudNamePresent: true, apiKeyPresent: true, apiSecretPresent: true, cloudinaryUrlPresent: false },
  });
  cloudinary.uploadFromBuffer = async (buffer, options) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(options, { folder: 'newspulse/media-library', resourceType: 'video' });
    return {
      secure_url: 'https://res.cloudinary.com/demo/video/upload/v123/newspulse/media-library/clip.mp4',
      public_id: 'newspulse/media-library/clip',
      bytes: 9876,
    };
  };

  const uploaded = await uploadMediaLibraryFile({ headers: {}, protocol: 'http', get: () => 'localhost:5000' }, {
    originalname: 'clip.mp4',
    mimetype: 'video/mp4',
    size: 6789,
    buffer: Buffer.from('mp4data'),
  });

  assert.equal(uploaded.provider, 'cloudinary');
  assert.equal(uploaded.storageProvider, 'CLOUDINARY');
  assert.equal(uploaded.url, 'https://res.cloudinary.com/demo/video/upload/v123/newspulse/media-library/clip.mp4');
  assert.equal(uploaded.assetUrl, uploaded.url);
  assert.equal(uploaded.videoUrl, uploaded.url);
  assert.equal(uploaded.posterUrl, 'https://res.cloudinary.com/demo/video/upload/so_0/v123/newspulse/media-library/clip.jpg');
  assert.equal(uploaded.thumbnailUrl, uploaded.posterUrl);
  assert.equal(uploaded.mimeType, 'video/mp4');
  assert.equal(uploaded.size, 9876);
});

test('Media Library upload rejects local disk fallback unless explicitly enabled', async (t) => {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevAllowFallback = process.env.MEDIA_LIBRARY_ALLOW_LOCAL_DISK_FALLBACK;
  const prevAllowLocal = process.env.MEDIA_LIBRARY_UPLOAD_ALLOW_LOCAL;
  const prevAllowLegacy = process.env.ALLOW_LOCAL_MEDIA_LIBRARY_UPLOADS;

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    if (prevAllowFallback === undefined) delete process.env.MEDIA_LIBRARY_ALLOW_LOCAL_DISK_FALLBACK;
    else process.env.MEDIA_LIBRARY_ALLOW_LOCAL_DISK_FALLBACK = prevAllowFallback;
    if (prevAllowLocal === undefined) delete process.env.MEDIA_LIBRARY_UPLOAD_ALLOW_LOCAL;
    else process.env.MEDIA_LIBRARY_UPLOAD_ALLOW_LOCAL = prevAllowLocal;
    if (prevAllowLegacy === undefined) delete process.env.ALLOW_LOCAL_MEDIA_LIBRARY_UPLOADS;
    else process.env.ALLOW_LOCAL_MEDIA_LIBRARY_UPLOADS = prevAllowLegacy;
  });

  delete process.env.MEDIA_LIBRARY_ALLOW_LOCAL_DISK_FALLBACK;
  delete process.env.MEDIA_LIBRARY_UPLOAD_ALLOW_LOCAL;
  delete process.env.ALLOW_LOCAL_MEDIA_LIBRARY_UPLOADS;
  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: false,
    mode: 'missing',
    missing: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
    cloudinaryUrlValid: null,
    env: { cloudNamePresent: false, apiKeyPresent: false, apiSecretPresent: false, cloudinaryUrlPresent: false },
  });

  await assert.rejects(
    () => uploadMediaLibraryFile({ headers: {}, protocol: 'http', get: () => 'localhost:5000' }, {
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 1234,
      buffer: Buffer.from('jpgdata'),
    }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'MEDIA_UPLOAD_NOT_CONFIGURED');
      assert.match(err.message, /missing cloudinary config/i);
      return true;
    }
  );
});

test('Cloudinary sync imports missing image and video assets into Media Library records', async (t) => {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevListResourcesByPrefix = cloudinary.listResourcesByPrefix;
  const prevFindOne = Media.findOne;
  const prevCreate = Media.create;
  const prevCloudinaryFolder = process.env.CLOUDINARY_FOLDER;

  const created = [];
  const calls = [];

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.listResourcesByPrefix = prevListResourcesByPrefix;
    Media.findOne = prevFindOne;
    Media.create = prevCreate;
    if (prevCloudinaryFolder === undefined) delete process.env.CLOUDINARY_FOLDER;
    else process.env.CLOUDINARY_FOLDER = prevCloudinaryFolder;
  });

  process.env.CLOUDINARY_FOLDER = 'newspulse/articles';
  cloudinary.getCloudinaryConfigStatus = () => ({ configured: true, mode: 'keys', missing: [], env: {} });
  cloudinary.listResourcesByPrefix = async ({ prefix, resourceType }) => {
    calls.push({ prefix, resourceType });
    if (prefix === 'newspulse/media-library' && resourceType === 'image') {
      return {
        resources: [{
          public_id: 'newspulse/media-library/imported-image',
          resource_type: 'image',
          secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/imported-image.jpg',
          format: 'jpg',
          bytes: 3456,
          created_at: '2026-05-01T10:00:00Z',
        }],
      };
    }
    if (prefix === 'newspulse/viral-videos' && resourceType === 'video') {
      return {
        resources: [{
          public_id: 'newspulse/viral-videos/imported-video',
          resource_type: 'video',
          secure_url: 'https://res.cloudinary.com/demo/video/upload/v1/newspulse/viral-videos/imported-video.mp4',
          format: 'mp4',
          bytes: 7890,
          created_at: '2026-05-02T11:00:00Z',
        }],
      };
    }
    return { resources: [] };
  };
  Media.findOne = async () => null;
  Media.create = async (payload) => {
    created.push(payload);
    return { _id: `media-${created.length}`, ...payload };
  };

  const summary = await syncCloudinaryMediaLibrary();

  assert.equal(summary.ok, true);
  assert.equal(summary.importedImages, 1);
  assert.equal(summary.importedVideos, 1);
  assert.equal(summary.skippedExisting, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.totalScanned, 2);
  assert.equal(created.length, 2);
  assert.ok(calls.some((call) => call.prefix === 'newspulse/articles' && call.resourceType === 'image'));
  assert.equal(created[0].storageProvider, 'CLOUDINARY');
  assert.equal(created[0].cloudinaryPublicId, 'newspulse/media-library/imported-image');
  assert.equal(created[0].mediaType, 'image');
  assert.equal(created[0].assetUrl, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/imported-image.jpg');
  assert.equal(created[1].mediaType, 'video');
  assert.equal(created[1].videoUrl, 'https://res.cloudinary.com/demo/video/upload/v1/newspulse/viral-videos/imported-video.mp4');
  assert.equal(created[1].posterUrl, 'https://res.cloudinary.com/demo/video/upload/so_0/v1/newspulse/viral-videos/imported-video.jpg');
});

test('Cloudinary sync skips duplicates and only fills empty existing fields', async (t) => {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevListResourcesByPrefix = cloudinary.listResourcesByPrefix;
  const prevFindOne = Media.findOne;
  const prevCreate = Media.create;
  const existing = {
    _id: 'existing-media',
    cloudinaryPublicId: 'newspulse/articles/existing-image',
    assetUrl: 'https://res.cloudinary.com/demo/image/upload/custom/existing-image.jpg',
    url: 'https://res.cloudinary.com/demo/image/upload/custom/existing-image.jpg',
    saveCalled: false,
    async save() { this.saveCalled = true; return this; },
  };
  let createCalled = false;

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.listResourcesByPrefix = prevListResourcesByPrefix;
    Media.findOne = prevFindOne;
    Media.create = prevCreate;
  });

  cloudinary.getCloudinaryConfigStatus = () => ({ configured: true, mode: 'keys', missing: [], env: {} });
  cloudinary.listResourcesByPrefix = async ({ prefix, resourceType }) => {
    if (prefix === 'newspulse/articles' && resourceType === 'image') {
      return {
        resources: [{
          public_id: 'newspulse/articles/existing-image',
          resource_type: 'image',
          secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/articles/existing-image.jpg',
          format: 'jpg',
          bytes: 1234,
          created_at: '2026-05-03T12:00:00Z',
        }],
      };
    }
    return { resources: [] };
  };
  Media.findOne = async () => existing;
  Media.create = async () => { createCalled = true; throw new Error('duplicate should not be created'); };

  const summary = await syncCloudinaryMediaLibrary({ prefixes: ['newspulse/articles'] });

  assert.equal(summary.importedImages, 0);
  assert.equal(summary.importedVideos, 0);
  assert.equal(summary.skippedExisting, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.totalScanned, 1);
  assert.equal(createCalled, false);
  assert.equal(existing.saveCalled, true);
  assert.equal(existing.assetUrl, 'https://res.cloudinary.com/demo/image/upload/custom/existing-image.jpg');
  assert.equal(existing.storageProvider, 'CLOUDINARY');
  assert.equal(existing.mediaType, 'image');
  assert.equal(existing.size, 1234);
});

test('POST /admin-api/media/upload rejects unsupported MIME types', async () => {
  const token = await loginAsAdmin();

  const res = await request(app)
    .post('/admin-api/media/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('gif89a'), {
      filename: 'bad.gif',
      contentType: 'image/gif',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, MEDIA_TYPE_NOT_ALLOWED_CODE);
  assert.equal(res.body.message, MEDIA_TYPE_NOT_ALLOWED_MESSAGE);
});

test('POST /api/uploads/cover rejects unsupported MIME types before Cloudinary upload', async () => {
  const res = await request(app)
    .post('/api/uploads/cover')
    .attach('cover', Buffer.from('gif89a'), {
      filename: 'bad.gif',
      contentType: 'image/gif',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, MEDIA_TYPE_NOT_ALLOWED_CODE);
  assert.equal(res.body.message, MEDIA_TYPE_NOT_ALLOWED_MESSAGE);
});

test('POST /api/uploads/cover uploads article cover through shared Cloudinary service', async (t) => {
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
      secure_url: 'https://res.cloudinary.com/demo/image/upload/article-cover.jpg',
      public_id: 'newspulse/articles/article-cover',
      width: 1200,
      height: 675,
      format: 'jpg',
      bytes: 2345,
    };
  };

  const res = await request(app)
    .post('/api/uploads/cover')
    .attach('cover', Buffer.from('jpgdata'), {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, {
    url: 'https://res.cloudinary.com/demo/image/upload/article-cover.jpg',
    secureUrl: 'https://res.cloudinary.com/demo/image/upload/article-cover.jpg',
    secure_url: 'https://res.cloudinary.com/demo/image/upload/article-cover.jpg',
    publicId: 'newspulse/articles/article-cover',
    public_id: 'newspulse/articles/article-cover',
    width: 1200,
    height: 675,
    format: 'jpg',
    bytes: 2345,
  });
});