const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.FOUNDER_EMAIL = process.env.FOUNDER_EMAIL || 'founder@example.com';

const NEWS_ID = '507f1f77bcf86cd799439041';
const founderCookie = `np_admin=${String(process.env.FOUNDER_EMAIL).toLowerCase()}`;

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch (_) {}
}

function makeDoc(overrides = {}) {
  return {
    _id: NEWS_ID,
    title: 'Publish target',
    description: 'Summary',
    content: '<p>Body</p>',
    slug: 'publish-target',
    slugs: { en: 'publish-target', hi: 'publish-target-hi', gu: 'publish-target-gu' },
    category: 'national',
    status: 'draft',
    lang: 'en',
    language: 'en',
    originalLang: 'en',
    translationGroupId: 'group-dangerous',
    translationKey: 'group-dangerous',
    sourceArticleId: null,
    workflowStage: 'DRAFT',
    coverImage: { url: 'https://img.example/cover.jpg', publicId: 'cover-1', alt: 'Cover' },
    coverImageUrl: 'https://img.example/cover.jpg',
    imageURL: 'https://img.example/cover.jpg',
    geo: { state: 'gujarat' },
    location: { stateSlug: 'gujarat' },
    workflowHistory: [],
    save: async function save() { return this; },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest };
    },
    ...overrides,
  };
}

function makeFindOneResult(doc) {
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

  translationGroupSync.syncTranslationGroupFromMaster = async (_doc, _options = {}) => ({
    ok: true,
    childrenUpdated: 0,
    childIds: [],
  });
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

test('POST /api/articles/:id/publish does not bulk-match public copies by translation group id', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const News = require('../models/News');
  const PublicArticle = require('../models/Article');
  const PushHistory = require('../models/PushHistory');

  const originals = {
    findById: News.findById,
    findOne: News.findOne,
    updateMany: PublicArticle.updateMany,
    pushHistoryCreate: PushHistory.create,
  };
  const { app, restore } = loadAppWithPatchedServices({});

  try {
    mongoose.connection.readyState = 1;

    News.findById = async (_id) => (String(_id) === NEWS_ID ? makeDoc() : null);
  News.findOne = () => makeFindOneResult(null);
    PushHistory.create = async () => null;

    let capturedQuery = null;
    let capturedUpdate = null;
    PublicArticle.updateMany = async (query, update) => {
      capturedQuery = query;
      capturedUpdate = update;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const res = await request(app)
      .post(`/api/articles/${NEWS_ID}/publish`)
      .set('Cookie', founderCookie)
      .send();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(capturedQuery);
    assert.ok(Array.isArray(capturedQuery.$or));
    assert.deepEqual(capturedUpdate.$set.status, 'published');

    const queryJson = JSON.stringify(capturedQuery);
    assert.equal(queryJson.includes('translationGroupId'), false);
    assert.equal(queryJson.includes('translationKey'), false);
    assert.equal(queryJson.includes('sourceNewsId'), true);
    assert.equal(queryJson.includes('sourceArticleId'), true);
  } finally {
    restore();
    News.findById = originals.findById;
    News.findOne = originals.findOne;
    PublicArticle.updateMany = originals.updateMany;
    PushHistory.create = originals.pushHistoryCreate;
    mongoose.connection.readyState = prevReadyState;
  }
});