const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const News = require('../models/News');
const googleTranslate = require('../services/googleTranslate.service');
const translationEnabled = require('../services/translationEnabled');
const syncPublicArticle = require('../services/syncPublicArticleFromNews.service');
const translationGroupSync = require('../services/translationGroupSync.service');

const originalFindById = News.findById;
const originalUpdateOne = News.updateOne;
const originalFindByIdAndUpdate = News.findByIdAndUpdate;
const originalTranslateMany = googleTranslate.translateMany;
const originalIsConfigured = translationEnabled.isGoogleTranslateConfigured;
const originalSyncPublic = syncPublicArticle.syncPublicArticleFromNews;
const originalSyncGroup = translationGroupSync.syncTranslationGroupFromMaster;

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