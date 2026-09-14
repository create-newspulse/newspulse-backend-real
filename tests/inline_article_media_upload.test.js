const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';

const app = require('../server');
const cloudinary = require('../lib/cloudinary');
const Media = require('../models/Media');
const News = require('../models/News');

const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const VALID_WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  return `np.${Buffer.from(`${email}:0`).toString('base64')}`;
}

function makeRoleJwt(role) {
  return jwt.sign({ sub: 'public-user', email: 'public@example.com', role }, process.env.JWT_SECRET || 'dev-secret-change-me');
}

function stubInlineStorage(t, options = {}) {
  const prevGetCloudinaryConfigStatus = cloudinary.getCloudinaryConfigStatus;
  const prevUploadFromBuffer = cloudinary.uploadFromBuffer;
  const prevCreate = Media.create;
  const prevFindById = Media.findById;
  const prevNewsCreate = News.create;
  const prevNewsUpdateOne = News.updateOne;
  const prevNewsFindOneAndUpdate = News.findOneAndUpdate;
  const prevNewsUpdateMany = News.updateMany;
  const captured = { mediaCreate: null, articleMutations: 0 };

  t.after(() => {
    cloudinary.getCloudinaryConfigStatus = prevGetCloudinaryConfigStatus;
    cloudinary.uploadFromBuffer = prevUploadFromBuffer;
    Media.create = prevCreate;
    Media.findById = prevFindById;
    News.create = prevNewsCreate;
    News.updateOne = prevNewsUpdateOne;
    News.findOneAndUpdate = prevNewsFindOneAndUpdate;
    News.updateMany = prevNewsUpdateMany;
  });

  cloudinary.getCloudinaryConfigStatus = () => ({
    configured: options.configured !== false,
    mode: options.configured === false ? 'missing' : 'keys',
    missing: options.configured === false ? ['CLOUDINARY_CLOUD_NAME'] : [],
    cloudinaryUrlValid: null,
    env: {
      cloudNamePresent: options.configured !== false,
      apiKeyPresent: options.configured !== false,
      apiSecretPresent: options.configured !== false,
      cloudinaryUrlPresent: false,
    },
  });

  cloudinary.uploadFromBuffer = async (buffer, uploadOptions) => {
    assert.ok(Buffer.isBuffer(buffer));
    assert.deepEqual(uploadOptions, { folder: 'newspulse/media-library', resourceType: 'image' });
    return {
      secure_url: options.url || 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.jpg',
      public_id: options.publicId || 'newspulse/media-library/inline',
      width: options.width ?? 1200,
      height: options.height ?? 800,
      bytes: options.bytes ?? buffer.length,
      format: options.format || 'jpg',
    };
  };

  Media.create = async (payload) => {
    captured.mediaCreate = payload;
    return {
      _id: options.mediaId || '507f1f77bcf86cd799439811',
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
      updatedAt: new Date('2026-09-14T00:00:00.000Z'),
      ...payload,
    };
  };

  Media.findById = (id) => ({
    lean: async () => ({
      _id: String(id),
      createdAt: new Date('2026-09-14T00:00:00.000Z'),
      updatedAt: new Date('2026-09-14T00:00:00.000Z'),
      ...captured.mediaCreate,
    }),
  });

  News.create = async () => { captured.articleMutations += 1; throw new Error('article create should not run'); };
  News.updateOne = async () => { captured.articleMutations += 1; throw new Error('article updateOne should not run'); };
  News.findOneAndUpdate = async () => { captured.articleMutations += 1; throw new Error('article findOneAndUpdate should not run'); };
  News.updateMany = async () => { captured.articleMutations += 1; throw new Error('article updateMany should not run'); };

  return captured;
}

async function uploadInlineImage(route, buffer, contentType, filename = 'inline.jpg') {
  return request(app)
    .post(route)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .attach('image', buffer, { filename, contentType });
}

test('anonymous inline article image upload is rejected', async () => {
  const res = await request(app)
    .post('/api/admin/articles/media/image')
    .attach('image', VALID_JPEG, { filename: 'inline.jpg', contentType: 'image/jpeg' });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('invalid role inline article image upload is rejected', async () => {
  const res = await request(app)
    .post('/api/admin/articles/media/image')
    .set('Authorization', `Bearer ${makeRoleJwt('public')}`)
    .attach('image', VALID_JPEG, { filename: 'inline.jpg', contentType: 'image/jpeg' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('authorized inline article JPEG upload creates article-inline Media record without mutating articles', async (t) => {
  const captured = stubInlineStorage(t, { format: 'jpg', width: 1200, height: 675, bytes: 2345 });

  const res = await uploadInlineImage('/api/admin/articles/media/image', VALID_JPEG, 'image/jpeg', 'inline.jpg');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.mediaId, '507f1f77bcf86cd799439811');
  assert.equal(res.body.data.storageId, 'newspulse/media-library/inline');
  assert.equal(res.body.data.url, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.jpg');
  assert.equal(res.body.data.width, 1200);
  assert.equal(res.body.data.height, 675);
  assert.equal(res.body.data.mimeType, 'image/jpeg');
  assert.equal(res.body.data.size, 2345);
  assert.equal(res.body.data.provider, 'cloudinary');
  assert.equal(res.body.data.source, 'article-inline');
  assert.deepEqual(res.body.data.uploadedBy, { id: 'opaque', email: 'admin@newspulse.ai', role: 'admin' });
  assert.equal(captured.mediaCreate.source, 'article-inline');
  assert.equal(captured.mediaCreate.mediaType, 'image');
  assert.equal(captured.mediaCreate.uploadedBy.email, 'admin@newspulse.ai');
  assert.equal(captured.articleMutations, 0);
});

test('authorized inline article PNG upload succeeds through admin-api alias', async (t) => {
  const captured = stubInlineStorage(t, {
    url: 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.png',
    publicId: 'newspulse/media-library/inline-png',
    format: 'png',
    width: 900,
    height: 600,
    bytes: 3456,
  });

  const res = await uploadInlineImage('/admin-api/admin/articles/media/image', VALID_PNG, 'image/png', 'inline.png');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.url, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.png');
  assert.equal(res.body.data.mimeType, 'image/png');
  assert.equal(res.body.data.source, 'article-inline');
  assert.equal(captured.mediaCreate.source, 'article-inline');
});

test('authorized inline article WebP upload succeeds', async (t) => {
  stubInlineStorage(t, {
    url: 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.webp',
    publicId: 'newspulse/media-library/inline-webp',
    format: 'webp',
    width: 800,
    height: 450,
    bytes: 987,
  });

  const res = await uploadInlineImage('/api/admin/articles/media/image', VALID_WEBP, 'image/webp', 'inline.webp');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.url, 'https://res.cloudinary.com/demo/image/upload/v1/newspulse/media-library/inline.webp');
  assert.equal(res.body.data.mimeType, 'image/webp');
});

test('inline article image upload rejects forged MIME and invalid signatures', async () => {
  const token = makeOpaqueAdminToken();

  const forged = await request(app)
    .post('/api/admin/articles/media/image')
    .set('Authorization', `Bearer ${token}`)
    .attach('image', Buffer.from('<html>not an image</html>'), { filename: 'fake.jpg', contentType: 'image/jpeg' });
  assert.equal(forged.statusCode, 422);
  assert.equal(forged.body.code, 'INVALID_MEDIA_SIGNATURE');

  const mismatch = await request(app)
    .post('/api/admin/articles/media/image')
    .set('Authorization', `Bearer ${token}`)
    .attach('image', VALID_JPEG, { filename: 'wrong.png', contentType: 'image/png' });
  assert.equal(mismatch.statusCode, 422);
  assert.equal(mismatch.body.code, 'INVALID_MEDIA_SIGNATURE');
});

test('inline article image upload rejects SVG and oversized files', async () => {
  const token = makeOpaqueAdminToken();

  const svg = await request(app)
    .post('/api/admin/articles/media/image')
    .set('Authorization', `Bearer ${token}`)
    .attach('image', Buffer.from('<svg><script>alert(1)</script></svg>'), { filename: 'bad.svg', contentType: 'image/svg+xml' });
  assert.equal(svg.statusCode, 400);
  assert.equal(svg.body.code, 'MEDIA_TYPE_NOT_ALLOWED');

  const oversized = await request(app)
    .post('/api/admin/articles/media/image')
    .set('Authorization', `Bearer ${token}`)
    .attach('image', Buffer.alloc((10 * 1024 * 1024) + 1), { filename: 'large.jpg', contentType: 'image/jpeg' });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.body.code, 'FILE_TOO_LARGE');
});

test('inline article image upload fails safely when durable Cloudinary storage is unavailable', async (t) => {
  stubInlineStorage(t, { configured: false });

  const res = await uploadInlineImage('/api/admin/articles/media/image', VALID_JPEG, 'image/jpeg', 'inline.jpg');

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'MEDIA_UPLOAD_NOT_CONFIGURED');
});
