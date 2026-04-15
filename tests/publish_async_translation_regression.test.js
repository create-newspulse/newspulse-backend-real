const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const News = require('../models/News');
const googleTranslate = require('../services/googleTranslate.service');
const translationEnabled = require('../services/translationEnabled');
const syncPublicArticle = require('../services/syncPublicArticleFromNews.service');
const translationGroupSync = require('../services/translationGroupSync.service');
const TranslationJob = require('../models/TranslationJob');

const originalFindById = News.findById;
const originalUpdateOne = News.updateOne;
const originalFindByIdAndUpdate = News.findByIdAndUpdate;
const originalTranslateMany = googleTranslate.translateMany;
const originalIsConfigured = translationEnabled.isGoogleTranslateConfigured;
const originalSyncPublic = syncPublicArticle.syncPublicArticleFromNews;
const originalSyncGroup = translationGroupSync.syncTranslationGroupFromMaster;
const originalJobFindOneAndUpdate = TranslationJob.findOneAndUpdate;

function makeLean(doc) {
  return {
    select() {
      return this;
    },
    lean: async () => doc,
  };
}

test.afterEach(() => {
  News.findById = originalFindById;
  News.updateOne = originalUpdateOne;
  News.findByIdAndUpdate = originalFindByIdAndUpdate;
  googleTranslate.translateMany = originalTranslateMany;
  translationEnabled.isGoogleTranslateConfigured = originalIsConfigured;
  syncPublicArticle.syncPublicArticleFromNews = originalSyncPublic;
  translationGroupSync.syncTranslationGroupFromMaster = originalSyncGroup;
  TranslationJob.findOneAndUpdate = originalJobFindOneAndUpdate;
});

test('translateAndSave handles translation failures without throwing docUpdated reference errors', async () => {
  const baseDoc = {
    _id: '507f1f77bcf86cd799439011',
    title: 'English title',
    description: 'English summary',
    content: '<p>English body</p>',
    lang: 'en',
    originalLang: 'en',
    slug: 'english-title',
    slugs: { en: 'english-title' },
    translations: {},
    translationStatus: {},
    translationError: {},
    translationNextRetryAt: {},
    translationUpdatedAt: {},
  };

  const updatedDocs = [];

  News.findById = () => makeLean(baseDoc);
  News.updateOne = async () => ({ acknowledged: true });
  News.findByIdAndUpdate = async (_id, update) => {
    updatedDocs.push(update);
    return { ...baseDoc, ...(update && update.$set ? update.$set : {}) };
  };

  translationEnabled.isGoogleTranslateConfigured = () => true;
  googleTranslate.translateMany = async () => ({ ok: false, error: 'Translate failed: synthetic' });
  syncPublicArticle.syncPublicArticleFromNews = async () => {};
  translationGroupSync.syncTranslationGroupFromMaster = async () => {};

  const { translateAndSave } = require('../services/publishAsyncTranslation.service');

  await assert.doesNotReject(() => translateAndSave(baseDoc._id, { logger: { warn() {}, error() {}, info() {} } }));
  assert.equal(updatedDocs.length > 0, true);
  assert.equal(updatedDocs.some((update) => {
    const set = update && update.$set ? update.$set : {};
    return Object.keys(set).some((key) => key.startsWith('translationStatus.') && set[key] === 'failed');
  }), true);
});

test('translateAndSave marks all non-base languages ready when translations succeed', async () => {
  const baseDoc = {
    _id: '507f1f77bcf86cd799439012',
    title: 'English title',
    description: 'English summary',
    content: '<p>English body</p>',
    lang: 'en',
    originalLang: 'en',
    slug: 'english-title',
    slugs: { en: 'english-title' },
    translations: {},
    translationStatus: {},
    translationError: {},
    translationNextRetryAt: {},
    translationUpdatedAt: {},
  };

  const updatedDocs = [];

  News.findById = () => makeLean(baseDoc);
  News.updateOne = async () => ({ acknowledged: true });
  News.findByIdAndUpdate = async (_id, update) => {
    updatedDocs.push(update);
    return { ...baseDoc, ...(update && update.$set ? update.$set : {}) };
  };

  translationEnabled.isGoogleTranslateConfigured = () => true;
  googleTranslate.translateMany = async (items, targetLang) => ({
    ok: true,
    items: items.map((item, index) => `${targetLang}-${index + 1}:${String(item)}`),
  });
  syncPublicArticle.syncPublicArticleFromNews = async () => {};
  translationGroupSync.syncTranslationGroupFromMaster = async () => {};

  const { translateAndSave } = require('../services/publishAsyncTranslation.service');

  await assert.doesNotReject(() => translateAndSave(baseDoc._id, { logger: { warn() {}, error() {}, info() {} } }));

  const mergedSet = Object.assign({}, ...updatedDocs.map((update) => (update && update.$set ? update.$set : {})));
  assert.equal(mergedSet['translationStatus.hi'], 'ready');
  assert.equal(mergedSet['translationStatus.gu'], 'ready');
  assert.equal(mergedSet['translationStatus.en'], 'ready');
  assert.equal(typeof mergedSet['translations.hi.title'], 'string');
  assert.equal(typeof mergedSet['translations.gu.title'], 'string');
  assert.equal(typeof mergedSet['translations.en.title'], 'string');
});

test('enqueueTranslateAndSave queues jobs even when translate config is currently unavailable', async () => {
  const calls = [];

  translationEnabled.isGoogleTranslateConfigured = () => false;
  TranslationJob.findOneAndUpdate = (...args) => {
    calls.push(args);
    return { lean: async () => ({}) };
  };

  const { enqueueTranslateAndSave } = require('../services/publishAsyncTranslation.service');
  await enqueueTranslateAndSave('507f1f77bcf86cd799439013', { logger: { warn() {}, error() {}, info() {} } });

  assert.equal(calls.length, 1);
  const [, update] = calls[0];
  assert.equal(update.$set.status, 'queued');
  assert.equal(update.$set.lastError, null);
});