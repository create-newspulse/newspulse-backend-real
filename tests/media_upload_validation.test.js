const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');
const cloudinary = require('../lib/cloudinary');
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