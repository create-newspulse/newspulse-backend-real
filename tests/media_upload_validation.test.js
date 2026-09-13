const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

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
const adminCompatRoutes = require('../src/routes/adminCompat.routes');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  return `np.${Buffer.from(`${email}:${Date.now()}`).toString('base64')}`;
}

const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const VALID_WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary');
const VALID_MP4 = Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42', 'binary');

function makeRoleJwt(role) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: 'public-user', email: 'public@example.com', role }, process.env.JWT_SECRET || 'dev-secret-change-me');
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

test('signature validation accepts current cover, media, and ad formats', () => {
  const validation = require('../lib/mediaUploadValidation');

  assert.equal(validation.assertAllowedArticleCoverUpload('image/jpeg', VALID_JPEG), 'image/jpeg');
  assert.equal(validation.assertAllowedArticleCoverUpload('image/png', VALID_PNG), 'image/png');
  assert.equal(validation.assertAllowedArticleCoverUpload('image/webp', VALID_WEBP), 'image/webp');
  assert.equal(validation.assertAllowedAdminMediaUpload('video/mp4', VALID_MP4), 'video/mp4');
  assert.equal(validation.assertAllowedAdImageUpload('image/gif', Buffer.from('GIF89a')), 'image/gif');
});

test('signature validation rejects text, mismatches, and SVG payloads', () => {
  const validation = require('../lib/mediaUploadValidation');

  assert.throws(() => validation.assertAllowedArticleCoverUpload('image/jpeg', Buffer.from('<html>nope</html>')), /does not match/);
  assert.throws(() => validation.assertAllowedArticleCoverUpload('image/png', VALID_JPEG), /does not match/);
  assert.throws(() => validation.assertAllowedArticleCoverUpload('image/jpeg', Buffer.from('<svg><script>alert(1)</script></svg>')), /does not match/);
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
  const token = makeOpaqueAdminToken();

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

test('POST /admin-api/media/upload rejects MIME/signature mismatches', async () => {
  const token = makeOpaqueAdminToken();

  const res = await request(app)
    .post('/admin-api/media/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', VALID_JPEG, {
      filename: 'wrong.png',
      contentType: 'image/png',
    });

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'INVALID_MEDIA_SIGNATURE');
});

test('POST /admin-api/media/upload rejects files above current size limit', async () => {
  const token = makeOpaqueAdminToken();

  const res = await request(app)
    .post('/admin-api/media/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.alloc((25 * 1024 * 1024) + 1), {
      filename: 'too-large.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 413);
});

test('compatibility /api/media/upload rejects anonymous access when mounted independently', async () => {
  const compatApp = express();
  compatApp.use('/api', adminCompatRoutes);

  const res = await request(compatApp)
    .post('/api/media/upload')
    .attach('file', VALID_JPEG, {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST /api/media/upload rejects anonymous access', async () => {
  const res = await request(app)
    .post('/api/media/upload')
    .attach('file', VALID_JPEG, {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST /api/uploads/cover rejects unsupported MIME types before Cloudinary upload', async () => {
  const token = makeOpaqueAdminToken();

  const res = await request(app)
    .post('/api/uploads/cover')
    .set('Authorization', `Bearer ${token}`)
    .attach('cover', Buffer.from('gif89a'), {
      filename: 'bad.gif',
      contentType: 'image/gif',
    });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, MEDIA_TYPE_NOT_ALLOWED_CODE);
  assert.equal(res.body.message, MEDIA_TYPE_NOT_ALLOWED_MESSAGE);
});

test('POST /api/uploads/cover rejects anonymous uploads', async () => {
  const res = await request(app)
    .post('/api/uploads/cover')
    .attach('cover', VALID_JPEG, {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST cover upload aliases reject anonymous uploads', async () => {
  for (const route of ['/admin-api/uploads/cover', '/admin-api/api/uploads/cover']) {
    const res = await request(app)
      .post(route)
      .attach('cover', VALID_JPEG, {
        filename: 'cover.jpg',
        contentType: 'image/jpeg',
      });

    assert.equal(res.statusCode, 401, route);
    assert.equal(res.body.code, 'UNAUTHORIZED', route);
  }
});

test('POST /api/uploads/cover rejects non-admin bearer tokens', async () => {
  const res = await request(app)
    .post('/api/uploads/cover')
    .set('Authorization', `Bearer ${makeRoleJwt('public')}`)
    .attach('cover', VALID_JPEG, {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
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

  const token = makeOpaqueAdminToken();

  const res = await request(app)
    .post('/api/uploads/cover')
    .set('Authorization', `Bearer ${token}`)
    .attach('cover', VALID_JPEG, {
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

test('POST /api/uploads rejects anonymous legacy uploads', async () => {
  const res = await request(app)
    .post('/api/uploads')
    .attach('file', VALID_PNG, {
      filename: 'legacy.png',
      contentType: 'image/png',
    });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST /api/uploads preserves legacy upload response for authorized callers', async () => {
  const token = makeOpaqueAdminToken();

  const res = await request(app)
    .post('/api/uploads')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', VALID_PNG, {
      filename: 'legacy.png',
      contentType: 'image/png',
    });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);
  assert.match(res.body.url, /\/uploads\//);
  assert.ok(res.body.filename);
  assert.equal(res.body.size, VALID_PNG.length);
  assert.equal(res.body.mime, 'image/png');
});