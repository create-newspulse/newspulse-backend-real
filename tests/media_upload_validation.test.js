const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');
const cloudinary = require('../lib/cloudinary');
const { uploadMediaLibraryFile } = require('../lib/mediaLibraryStorage');
const {
  ADMIN_MEDIA_ACCEPTED_MIME_TYPES,
  ARTICLE_COVER_ACCEPTED_MIME_TYPES,
  MEDIA_TYPE_NOT_ALLOWED_CODE,
  MEDIA_TYPE_NOT_ALLOWED_MESSAGE,
} = require('../lib/mediaUploadValidation');
const { deriveMediaType } = require('../services/mediaLibraryService');

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