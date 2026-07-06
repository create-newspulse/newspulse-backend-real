const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const Media = require('../models/Media');
const Article = require('../models/Article');
const News = require('../models/News');
const ViralVideo = require('../models/ViralVideo');
const Ad = require('../models/Ad');
const SponsoredFeature = require('../models/SponsoredFeature');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const cloudinaryUploads = require('../lib/cloudinary');
const service = require('../services/mediaLibraryService');
const app = require('../server');

function adminToken(email = 'admin@newspulse.ai') {
  return `np.${Buffer.from(`${email}:0`).toString('base64')}`;
}

function makeMediaDoc(fields = {}) {
  const doc = {
    _id: fields._id || 'media-1',
    storageId: fields.storageId || 'storage-1',
    publicId: fields.publicId || fields.storageId || 'storage-1',
    provider: fields.provider || 'cloudinary',
    storageProvider: fields.storageProvider || 'CLOUDINARY',
    mediaType: fields.mediaType || 'image',
    fileName: fields.fileName || 'asset.jpg',
    filename: fields.filename || fields.fileName || 'asset.jpg',
    assetUrl: fields.assetUrl || 'https://cdn.newspulse.test/media/asset.jpg',
    url: fields.url || fields.assetUrl || 'https://cdn.newspulse.test/media/asset.jpg',
    secureUrl: fields.secureUrl || fields.assetUrl || 'https://cdn.newspulse.test/media/asset.jpg',
    status: fields.status || 'active',
    isDeleted: fields.isDeleted === true,
    deletedAt: fields.deletedAt || null,
    trashedAt: fields.trashedAt || null,
    restoredAt: fields.restoredAt || null,
    isUsed: fields.isUsed === true,
    usageCount: fields.usageCount || 0,
    savedCount: 0,
    async save() {
      this.savedCount += 1;
      return this;
    },
    toObject() {
      return { ...this };
    },
  };
  return doc;
}

function queryWithDocs(docs) {
  return {
    limit() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return Promise.resolve(docs);
    },
  };
}

function installBulkMediaStubs(t, options = {}) {
  const records = options.records || [];
  const modelEntries = [
    [News, options.news || []],
    [Article, options.articles || []],
    [ViralVideo, options.viralVideos || []],
    [Ad, options.ads || []],
    [SponsoredFeature, options.sponsoredFeatures || []],
    [PublicSiteSettings, options.siteSettings || []],
  ];

  const originals = [
    [Media, 'findById', Media.findById],
    [Media, 'findOne', Media.findOne],
    [Media, 'find', Media.find],
    [Media, 'countDocuments', Media.countDocuments],
    [cloudinaryUploads, 'isCloudinaryConfigured', cloudinaryUploads.isCloudinaryConfigured],
    [cloudinaryUploads, 'deleteAssetByPublicId', cloudinaryUploads.deleteAssetByPublicId],
    ...modelEntries.map(([model]) => [model, 'find', model.find]),
  ];
  t.after(() => {
    for (const [target, key, original] of originals) target[key] = original;
  });

  Media.findById = async (id) => records.find((record) => String(record._id) === String(id)) || null;
  Media.findOne = async (filter) => records.find((record) => String(record.storageId || '') === String(filter?.storageId || '')) || null;
  Media.find = () => queryWithDocs(records.map((record) => record.toObject()));
  Media.countDocuments = async (filter = {}) => {
    if (filter.usageCount && filter.usageCount.$gt === 0) return records.filter((record) => record.usageCount > 0).length;
    if (filter.mediaType === 'video') return records.filter((record) => record.mediaType === 'video' && record.status === 'active').length;
    if (filter.mediaType && Array.isArray(filter.mediaType.$in)) return records.filter((record) => filter.mediaType.$in.includes(record.mediaType) && record.status === 'active').length;
    if (Array.isArray(filter.$or)) return records.filter((record) => record.status === 'trashed' || record.status === 'trash' || (record.isDeleted && record.status !== 'deleted')).length;
    if (filter.status === 'deleted') return records.filter((record) => record.status === 'deleted').length;
    if (filter.status && filter.status.$nin) return records.filter((record) => !record.isDeleted && !filter.status.$nin.includes(record.status)).length;
    return records.length;
  };

  for (const [model, docs] of modelEntries) {
    model.find = () => queryWithDocs(docs);
  }
  cloudinaryUploads.isCloudinaryConfigured = () => false;
  cloudinaryUploads.deleteAssetByPublicId = async () => ({ result: 'not-called' });
}

test('bulk usage check detects media references and stores usage counters', async (t) => {
  const media = makeMediaDoc({
    _id: 'media-used',
    storageId: 'storage-used',
    publicId: 'newspulse/media/storage-used',
    assetUrl: 'https://cdn.newspulse.test/media/storage-used.jpg',
  });
  installBulkMediaStubs(t, {
    records: [media],
    articles: [{ _id: 'article-1', title: 'River cleanup', body: '<img src="https://cdn.newspulse.test/media/storage-used.jpg">' }],
  });

  const results = await service.bulkUsageCheck(['media-used']);

  assert.equal(results.length, 1);
  assert.equal(results[0].isUsed, true);
  assert.equal(results[0].usageCount, 1);
  assert.equal(results[0].usages[0].type, 'article');
  assert.equal(results[0].usages[0].section, 'Public Article');
  assert.equal(media.isUsed, true);
  assert.equal(media.usageCount, 1);
  assert.equal(media.savedCount, 1);
});

test('bulk trash blocks used media unless founder confirmation is supplied', async (t) => {
  const media = makeMediaDoc({ _id: 'media-trash-used', storageId: 'storage-trash-used' });
  installBulkMediaStubs(t, {
    records: [media],
    news: [{ _id: 'news-1', title: 'Homepage lead', coverImage: media.assetUrl }],
  });

  await assert.rejects(
    () => service.bulkTrashMedia(['media-trash-used']),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'MEDIA_IN_USE_CONFIRM_REQUIRED');
      assert.equal(error.results[0].isUsed, true);
      return true;
    },
  );

  const forced = await service.bulkTrashMedia(['media-trash-used'], { forceFounderConfirm: true });
  assert.deepEqual(forced.trashedIds, ['media-trash-used']);
  assert.equal(media.status, 'trashed');
  assert.equal(media.isDeleted, true);
  assert.ok(media.trashedAt instanceof Date);
  assert.equal(media.assetUrl, 'https://cdn.newspulse.test/media/asset.jpg');
});

test('bulk restore reactivates trashed media records', async (t) => {
  const media = makeMediaDoc({ _id: 'media-restore', storageId: 'storage-restore', status: 'trashed', isDeleted: true, trashedAt: new Date() });
  installBulkMediaStubs(t, { records: [media] });

  const restored = await service.bulkRestoreMedia(['storage-restore']);

  assert.deepEqual(restored.restoredIds, ['media-restore']);
  assert.equal(media.status, 'active');
  assert.equal(media.isDeleted, false);
  assert.equal(media.trashedAt, null);
  assert.ok(media.restoredAt instanceof Date);
});

test('bulk permanent delete requires exact confirmation and only deletes trashed unused media', async (t) => {
  const active = makeMediaDoc({ _id: 'media-active', storageId: 'storage-active', status: 'active' });
  const trashed = makeMediaDoc({ _id: 'media-delete', storageId: 'storage-delete', status: 'trashed', isDeleted: true, trashedAt: new Date() });
  installBulkMediaStubs(t, { records: [active, trashed] });

  await assert.rejects(
    () => service.bulkPermanentDeleteMedia(['media-delete'], { confirm: 'DELETE' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'PERMANENT_DELETE_CONFIRM_REQUIRED');
      return true;
    },
  );

  const result = await service.bulkPermanentDeleteMedia(['media-active', 'media-delete'], { confirm: 'PERMANENT DELETE' });

  assert.deepEqual(result.skippedIds, ['media-active']);
  assert.deepEqual(result.permanentlyDeletedIds, ['media-delete']);
  assert.equal(trashed.status, 'deleted');
  assert.equal(trashed.isDeleted, true);
  assert.ok(trashed.deletedAt instanceof Date);
});

test('new /api/admin/media bulk usage route is authenticated and mounted', async (t) => {
  const media = makeMediaDoc({ _id: 'media-route', storageId: 'storage-route', assetUrl: 'https://cdn.newspulse.test/media/route.jpg' });
  installBulkMediaStubs(t, {
    records: [media],
    viralVideos: [{ _id: 'video-1', title: 'Route check', videoUrl: 'https://cdn.newspulse.test/media/route.jpg' }],
  });

  const res = await request(app)
    .post('/api/admin/media/bulk-usage-check')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ ids: ['media-route'] });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.results[0].isUsed, true);
  assert.equal(res.body.results[0].usages[0].type, 'viral-video');
});

test('media stats expose admin library counters expected by the client', async (t) => {
  const activeImage = makeMediaDoc({ _id: 'image-1', storageId: 'image-1', mediaType: 'image', usageCount: 1 });
  const activeVideo = makeMediaDoc({ _id: 'video-1', storageId: 'video-1', mediaType: 'video' });
  const trash = makeMediaDoc({ _id: 'trash-1', storageId: 'trash-1', status: 'trashed', isDeleted: true });
  installBulkMediaStubs(t, { records: [activeImage, activeVideo, trash] });

  const stats = await service.getIndexedMediaStats();

  assert.equal(stats.all, 3);
  assert.equal(stats.activeMedia, 2);
  assert.equal(stats.active, 2);
  assert.equal(stats.images, 1);
  assert.equal(stats.photos, 1);
  assert.equal(stats.videos, 1);
  assert.equal(stats.usedAssets, 1);
  assert.equal(stats.trash, 1);
});