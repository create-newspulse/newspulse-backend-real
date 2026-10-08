process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';
process.env.JWT_SECRET = 'creative-preparation-isolated-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { v2: provider } = require('cloudinary');
const cloudinary = require('../lib/cloudinary');
const imageUpload = require('../src/utils/adImageUpload');
const { AD_IMAGE_SLOT_SIZES } = require('../src/constants/adSlots');
const { prepareAdCreative } = require('../services/adCreativeService');
const Ad = require('../models/Ad');
const User = require('../models/User');
const AdSettings = require('../models/AdSettings');
const AdPerformanceDaily = require('../models/AdPerformanceDaily');
const PublicConfigVersion = require('../models/PublicConfigVersion');
const adsRouter = require('../routes/ads.routes');

const app = express();
app.use(express.json());
app.use('/api/ads', adsRouter);

function authenticate(context, req) {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previousReadyState; });
  const userId = '507f1f77bcf86cd799439101';
  context.mock.method(User, 'findById', () => ({ lean: async () => ({
    _id: userId, email: 'admin@example.test', role: 'founder', status: 'active',
    tokenVersion: 0, noExpiry: true, isFounder: true,
  }) }));
  for (const model of [Ad, AdSettings, AdPerformanceDaily, PublicConfigVersion]) {
    for (const method of ['create', 'updateOne', 'findByIdAndUpdate', 'findOneAndUpdate']) {
      context.mock.method(model, method, () => { assert.fail('Creative preparation must not write to the database'); });
    }
  }
  const token = jwt.sign({ sub: userId, role: 'founder', type: 'access', tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return req.set('Authorization', `Bearer ${token}`);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const SOURCE_URL = 'https://res.cloudinary.com/creative-test/image/upload/source.png';

function preparedImageUrl(width, height) {
  return `https://res.cloudinary.com/creative-test/image/upload/c_fill,g_center,h_${height},w_${width}/source.png`;
}

function stubImages(context, { width = 1920, height = 1200, format = 'png', pages = 1 } = {}) {
  const calls = { uploads: [], transforms: [] };
  context.mock.method(cloudinary, 'isCloudinaryConfigured', () => true);
  context.mock.method(cloudinary, 'uploadFromBuffer', async (buffer, options) => {
    calls.uploads.push({ buffer: Buffer.from(buffer), options });
    return { public_id: 'ads/sources/source', secure_url: SOURCE_URL, width, height, format, pages };
  });
  context.mock.method(cloudinary, 'generateImageDerivative', async (publicId, dimensions) => {
    calls.transforms.push({ publicId, dimensions });
    return { secure_url: preparedImageUrl(dimensions.width, dimensions.height), width: dimensions.width, height: dimensions.height, format: 'png' };
  });
  return calls;
}

function prepare(slot, extra = {}) {
  return prepareAdCreative({ slot, buffer: PNG, contentType: 'image/png', ...extra });
}

for (const [slot, dimensions] of Object.entries(AD_IMAGE_SLOT_SIZES)) {
  test(`creative preparation supports ${slot} at its exact 1x dimensions`, async (context) => {
    const calls = stubImages(context);
    const result = await prepare(slot);
    assert.equal(result.slot, slot);
    assert.equal(result.width, dimensions.width);
    assert.equal(result.height, dimensions.height);
    assert.equal(result.hostedUrl, preparedImageUrl(dimensions.width, dimensions.height));
    assert.equal(result.originalImageUrl, SOURCE_URL);
    assert.equal(result.fit, 'cover');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(calls.transforms, [{ publicId: 'ads/sources/source', dimensions }]);
    assert.deepEqual(calls.uploads[0].buffer, PNG);
    assert.equal(calls.uploads[0].options.transformation, undefined);
    assert.ok(calls.uploads[0].options.publicId.startsWith('ad-source-'));
  });
}

for (const [label, slot, width, height] of [
  ['portrait to landscape', 'CATEGORY_TOP_970x90', 1200, 1920],
  ['landscape to portrait', 'HOME_LEFT_300x600', 1920, 885],
  ['already correct ratio', 'HOME_728x90', 728, 90],
  ['high resolution 2x', 'CATEGORY_TOP_970x90', 1940, 180],
  ['1920x885 category example', 'CATEGORY_TOP_970x90', 1920, 885],
]) {
  test(`creative cover fit handles ${label} without requesting an upscale`, async (context) => {
    stubImages(context, { width, height });
    const result = await prepare(slot);
    assert.ok(result.width <= width && result.height <= height);
    assert.equal(result.width / result.height, AD_IMAGE_SLOT_SIZES[slot].aspectRatio);
    assert.equal(result.sourceWidth, width);
    assert.equal(result.sourceHeight, height);
  });
}

for (const slot of ['ARTICLE_INLINE', 'ARTICLE_END']) {
  for (const [label, width, height] of [
    ['landscape', 1920, 885],
    ['portrait', 885, 1920],
    ['already correct', 300, 250],
  ]) {
    test(`${slot} prepares a ${label} source with effective 300x250 metadata and an unchanged original`, async (context) => {
      const calls = stubImages(context, { width, height });
      const originalBytes = Buffer.from(PNG);
      const result = await prepare(slot);
      assert.deepEqual(result, {
        hostedUrl: preparedImageUrl(300, 250), slot, width: 300, height: 250,
        originalImageUrl: SOURCE_URL, sourceWidth: width, sourceHeight: height,
        fit: 'cover', warnings: [],
      });
      assert.equal(result.width / result.height, 6 / 5);
      assert.deepEqual(calls.transforms, [{
        publicId: 'ads/sources/source', dimensions: { slot, width: 300, height: 250, aspectRatio: 6 / 5 },
      }]);
      assert.deepEqual(PNG, originalBytes);
      assert.deepEqual(calls.uploads[0].buffer, originalBytes);
      assert.equal(calls.uploads[0].options.transformation, undefined);
    });
  }
}

test('article slots reject derivatives that still report source dimensions', async (context) => {
  stubImages(context, { width: 1920, height: 885 });
  context.mock.method(cloudinary, 'generateImageDerivative', async () => ({
    secure_url: preparedImageUrl(300, 250), width: 1920, height: 885, format: 'png',
  }));
  for (const slot of ['ARTICLE_INLINE', 'ARTICLE_END']) {
    await assert.rejects(() => prepare(slot), { status: 502, code: 'INVALID_PREPARED_CREATIVE' });
  }
});

test('repeated preparations preserve source bytes and use unique non-overwriting source IDs', async (context) => {
  const calls = stubImages(context);
  const originalBytes = Buffer.from(PNG);
  await prepare('CATEGORY_TOP_970x90');
  await prepare('HOME_BILLBOARD_970x250');
  assert.deepEqual(PNG, originalBytes);
  assert.deepEqual(calls.uploads[0].buffer, originalBytes);
  assert.deepEqual(calls.uploads[1].buffer, originalBytes);
  assert.notEqual(calls.uploads[0].options.publicId, calls.uploads[1].options.publicId);
});

test('low resolution is rejected with a useful warning and no transformation', async (context) => {
  const calls = stubImages(context, { width: 600, height: 90 });
  await assert.rejects(() => prepare('CATEGORY_TOP_970x90'), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'SOURCE_TOO_SMALL');
    assert.equal(error.warnings[0].code, 'LOW_SOURCE_RESOLUTION');
    assert.match(error.warnings[0].message, /970x90/);
    return true;
  });
  assert.equal(calls.transforms.length, 0);
});

test('unsized, text-only, unknown slots and unsupported fit modes fail before uploading', async (context) => {
  const calls = stubImages(context);
  for (const slot of ['BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR']) {
    await assert.rejects(() => prepare(slot), { code: 'AD_SLOT_SIZE_UNDEFINED' });
  }
  for (const slot of ['UNKNOWN', 'BREAKING_TICKER_RED', 'LIVE_UPDATES_TICKER_BLUE', 'BREAKING_PAGE_SPONSOR_LINE', 'SPONSORED_ARTICLE']) {
    await assert.rejects(() => prepare(slot), { code: 'INVALID_AD_SLOT' });
  }
  await assert.rejects(() => prepare('HOME_728x90', { fit: 'stretch' }), { code: 'INVALID_CREATIVE_FIT' });
  assert.equal(calls.uploads.length, 0);
});

test('invalid images, MIME mismatches, unsupported formats and oversized files are rejected', async (context) => {
  const calls = stubImages(context);
  for (const extra of [
    { buffer: Buffer.from('<html>not an image</html>') },
    { contentType: 'image/jpeg' },
    { contentType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    { buffer: Buffer.alloc(0) },
    { buffer: Buffer.alloc(imageUpload.MAX_BYTES + 1) },
    { imageUrl: 'https://public.example/source.png' },
  ]) await assert.rejects(() => prepare('HOME_728x90', extra));
  assert.equal(calls.uploads.length, 0);
});

test('HTTPS source preparation reuses the guarded downloader and preserves downloaded bytes', async (context) => {
  const calls = stubImages(context);
  context.mock.method(imageUpload, 'downloadImageToBuffer', async (url, options) => {
    assert.equal(url, 'https://public.example/source.png');
    assert.deepEqual(options, { httpsOnly: true });
    return { buffer: PNG, contentType: 'image/png' };
  });
  const result = await prepareAdCreative({ slot: 'CATEGORY_TOP_970x90', imageUrl: 'https://public.example/source.png' });
  assert.deepEqual(calls.uploads[0].buffer, PNG);
  assert.equal(result.originalImageUrl, SOURCE_URL);
});

test('service rejects corrupt provider-decoded images, unsafe metadata and wrong output dimensions', async (context) => {
  stubImages(context);
  context.mock.method(cloudinary, 'uploadFromBuffer', async () => { throw { http_code: 400, message: 'provider-private-details' }; });
  await assert.rejects(() => prepare('HOME_728x90'), { status: 422, message: 'Source image could not be decoded' });
  stubImages(context, { width: 10000, height: 10000 });
  await assert.rejects(() => prepare('HOME_728x90'), { code: 'SOURCE_IMAGE_TOO_LARGE' });
  stubImages(context, { format: 'svg' });
  await assert.rejects(() => prepare('HOME_728x90'), { code: 'INVALID_SOURCE_IMAGE' });
  stubImages(context);
  context.mock.method(cloudinary, 'generateImageDerivative', async () => ({ secure_url: preparedImageUrl(728, 90), width: 1, height: 1, format: 'png' }));
  await assert.rejects(() => prepare('HOME_728x90'), { code: 'INVALID_PREPARED_CREATIVE' });
});

test('Cloudinary is required; no silent unprepared fallback is returned', async (context) => {
  stubImages(context);
  context.mock.method(cloudinary, 'isCloudinaryConfigured', () => false);
  await assert.rejects(() => prepare('HOME_728x90'), { status: 503, code: 'CLOUDINARY_NOT_CONFIGURED' });
});

test('existing rail alias resolves to canonical image dimensions and animation gets a static warning', async (context) => {
  stubImages(context, { format: 'gif', pages: 2 });
  const result = await prepare('HOME_RIGHT_RAIL');
  assert.equal(result.slot, 'HOME_RIGHT_300x250');
  assert.equal(result.warnings[0].code, 'STATIC_CREATIVE');
});

test('Cloudinary adapter uses centered fill, static PNG, synchronous generation and no source overwrite', async (context) => {
  for (const [key, value] of Object.entries({ CLOUDINARY_CLOUD_NAME: 'creative-test', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret' })) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  context.mock.method(provider.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.overwrite, false);
    assert.equal(options.transformation, undefined);
    assert.equal(options.timeout, 10000);
    assert.deepEqual(options.allowed_formats, ['png']);
    return { end: (buffer) => { assert.deepEqual(buffer, PNG); callback(null, { secure_url: SOURCE_URL }); } };
  });
  await cloudinary.uploadFromBuffer(PNG, { allowedFormats: ['png'], timeout: 10000 });
  for (const [width, height] of [[970, 90], [300, 250]]) {
    context.mock.method(provider.uploader, 'explicit', async (publicId, options) => {
      assert.equal(publicId, 'ads/sources/source');
      assert.deepEqual(options, {
        type: 'upload', resource_type: 'image',
        eager: [{ width, height, crop: 'fill', gravity: 'center', format: 'png' }],
        eager_async: false, timeout: 10000,
      });
      return { eager: [{ width, height, format: 'png', secure_url: preparedImageUrl(width, height) }] };
    });
    const result = await cloudinary.generateImageDerivative('ads/sources/source', { width, height });
    assert.equal(result.width, width);
    assert.equal(result.height, height);
  }
});

test('upload route requires Admin authentication before preparing or downloading a creative', async (context) => {
  const calls = stubImages(context);
  const response = await request(app).post('/api/ads/upload-image')
    .send({ slot: 'CATEGORY_TOP_970x90', imageUrl: 'https://public.example/source.png' });
  assert.equal(response.status, 401);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.transforms.length, 0);
});

test('authenticated multipart preparation returns preview metadata without campaign, settings or tracking writes', async (context) => {
  stubImages(context, { width: 1920, height: 885 });
  const response = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .field('slot', 'CATEGORY_TOP_970x90').field('fit', 'cover')
    .attach('file', PNG, { filename: 'source.png', contentType: 'image/png' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    hostedUrl: preparedImageUrl(970, 90), slot: 'CATEGORY_TOP_970x90', width: 970, height: 90,
    originalImageUrl: SOURCE_URL, sourceWidth: 1920, sourceHeight: 885,
    fit: 'cover', warnings: [],
  });
});

for (const slot of ['ARTICLE_INLINE', 'ARTICLE_END']) {
  for (const input of ['multipart', 'json']) {
    test(`${slot} ${input} preparation reports derivative dimensions without saving source dimensions to a campaign`, async (context) => {
      stubImages(context, { width: 1920, height: 885 });
      context.mock.method(imageUpload, 'downloadImageToBuffer', async (_url, options) => {
        assert.equal(options.httpsOnly, true);
        return { buffer: PNG, contentType: 'image/png' };
      });
      const req = authenticate(context, request(app).post('/api/ads/upload-image'));
      const response = input === 'multipart'
        ? await req.field('slot', slot).attach('file', PNG, { filename: 'source.png', contentType: 'image/png' })
        : await req.send({ slot, imageUrl: 'https://public.example/source.png', width: 1920, height: 885 });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        hostedUrl: preparedImageUrl(300, 250), slot, width: 300, height: 250,
        originalImageUrl: SOURCE_URL, sourceWidth: 1920, sourceHeight: 885,
        fit: 'cover', warnings: [],
      });
    });
  }
}

test('authenticated JSON HTTPS preparation returns the same preview contract without database writes', async (context) => {
  stubImages(context);
  context.mock.method(imageUpload, 'downloadImageToBuffer', async (_url, options) => {
    assert.equal(options.httpsOnly, true);
    return { buffer: PNG, contentType: 'image/png' };
  });
  const response = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .send({ slot: 'HOME_LEFT_300x600', imageUrl: 'https://public.example/source.png' });
  assert.equal(response.status, 200);
  assert.equal(response.body.slot, 'HOME_LEFT_300x600');
  assert.equal(response.body.width, 300);
  assert.equal(response.body.height, 600);
  assert.equal(response.body.originalImageUrl, SOURCE_URL);
});

test('upload route reports low-resolution warnings and rejects unsupported slots and malformed files', async (context) => {
  stubImages(context, { width: 100, height: 100 });
  const low = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .field('slot', 'CATEGORY_TOP_970x90').attach('file', PNG, { filename: 'source.png', contentType: 'image/png' });
  assert.equal(low.status, 422);
  assert.equal(low.body.hostedUrl, null);
  assert.equal(low.body.warnings[0].code, 'LOW_SOURCE_RESOLUTION');
  for (const slot of ['BREAKING_SPONSOR', 'LIVE_UPDATE_SPONSOR']) {
    const unsized = await authenticate(context, request(app).post('/api/ads/upload-image'))
      .field('slot', slot).attach('file', PNG, { filename: 'source.png', contentType: 'image/png' });
    assert.equal(unsized.status, 422);
    assert.equal(unsized.body.code, 'AD_SLOT_SIZE_UNDEFINED');
  }
  const invalid = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .field('slot', 'HOME_728x90').attach('file', Buffer.from('not an image'), { filename: 'fake.png', contentType: 'image/png' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'INVALID_MEDIA_SIGNATURE');
  const oversized = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .field('slot', 'HOME_728x90').attach('file', Buffer.alloc(imageUpload.MAX_BYTES + 1), { filename: 'large.png', contentType: 'image/png' });
  assert.equal(oversized.status, 413);
});

test('legacy file-only upload keeps its hostedUrl-only response and does not transform', async (context) => {
  for (const [key, value] of Object.entries({ CLOUDINARY_CLOUD_NAME: 'creative-test', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret' })) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  context.mock.method(cloudinary, 'generateImageDerivative', () => assert.fail('Legacy upload must not transform'));
  context.mock.method(provider.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.overwrite, false);
    assert.equal(options.transformation, undefined);
    return { end: (buffer) => { assert.deepEqual(buffer, PNG); callback(null, { secure_url: SOURCE_URL }); } };
  });
  const response = await authenticate(context, request(app).post('/api/ads/upload-image'))
    .attach('file', PNG, { filename: 'source.png', contentType: 'image/png' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { hostedUrl: SOURCE_URL });
});
