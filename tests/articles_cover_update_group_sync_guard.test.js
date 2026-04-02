const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const NEWS_ID = '507f1f77bcf86cd799439011';

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch (_) {}
}

function makeFindByIdResult(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
    then(resolve, reject) {
      return Promise.resolve(doc).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(doc).catch(reject);
    },
  };
}

function makeUpdatedDoc(overrides = {}) {
  return {
    _id: NEWS_ID,
    title: 'Updated title',
    description: 'Updated summary',
    content: '<p>Updated body</p>',
    slug: 'updated-title',
    slugs: { en: 'updated-title' },
    lang: 'en',
    language: 'en',
    originalLang: 'en',
    category: 'national',
    status: 'published',
    workflowStage: 'PUBLISHED',
    translationGroupId: 'group-1',
    sourceArticleId: null,
    coverImage: { url: 'https://img.example/updated-cover.jpg', publicId: 'updated-cover', alt: null },
    coverImageUrl: 'https://img.example/updated-cover.jpg',
    imageURL: 'https://img.example/updated-cover.jpg',
    save: async function save() { return this; },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest };
    },
    ...overrides,
  };
}

function loadAppWithPatchedServices(track) {
  clearModule('../server');
  clearModule('../routes/articles.routes');
  clearModule('../services/translationGroupSync.service');
  clearModule('../services/syncPublicArticleFromNews.service');

  const translationGroupSync = require('../services/translationGroupSync.service');
  const syncPublicArticleService = require('../services/syncPublicArticleFromNews.service');

  const originals = {
    syncTranslationGroupFromMaster: translationGroupSync.syncTranslationGroupFromMaster,
    syncPublicArticleFromNews: syncPublicArticleService.syncPublicArticleFromNews,
  };

  translationGroupSync.syncTranslationGroupFromMaster = async (doc, options = {}) => {
    track.calls.push({ doc, options });
    return { ok: true, childrenUpdated: 0, childIds: [] };
  };
  syncPublicArticleService.syncPublicArticleFromNews = async () => null;

  const app = require('../server');

  return {
    app,
    restore() {
      translationGroupSync.syncTranslationGroupFromMaster = originals.syncTranslationGroupFromMaster;
      syncPublicArticleService.syncPublicArticleFromNews = originals.syncPublicArticleFromNews;
      clearModule('../server');
      clearModule('../routes/articles.routes');
      clearModule('../services/translationGroupSync.service');
      clearModule('../services/syncPublicArticleFromNews.service');
    },
  };
}

test('PUT /api/articles/:id keeps cover updates local by default', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const News = require('../models/News');
  const originals = {
    findById: News.findById,
    findByIdAndUpdate: News.findByIdAndUpdate,
  };
  const track = { calls: [] };
  const { app, restore } = loadAppWithPatchedServices(track);

  try {
    mongoose.connection.readyState = 1;

    News.findById = () => makeFindByIdResult({
      _id: NEWS_ID,
      title: 'Original title',
      description: 'Original summary',
      content: '<p>Original body</p>',
      slug: 'original-title',
      slugs: { en: 'original-title' },
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      category: 'national',
      status: 'published',
      workflowStage: 'PUBLISHED',
      translationGroupId: 'group-1',
      sourceArticleId: null,
      coverImage: { url: 'https://img.example/original-cover.jpg', publicId: 'original-cover', alt: null },
      coverImageUrl: 'https://img.example/original-cover.jpg',
      imageURL: 'https://img.example/original-cover.jpg',
      syncVersion: 1,
    });
    News.findByIdAndUpdate = async () => makeUpdatedDoc();

    const res = await request(app)
      .put(`/api/articles/${NEWS_ID}`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        coverImage: {
          url: 'https://img.example/updated-cover.jpg',
          publicId: 'updated-cover',
        },
      });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(track.calls.length, 0);
  } finally {
    restore();
    News.findById = originals.findById;
    News.findByIdAndUpdate = originals.findByIdAndUpdate;
    mongoose.connection.readyState = prevReadyState;
  }
});

