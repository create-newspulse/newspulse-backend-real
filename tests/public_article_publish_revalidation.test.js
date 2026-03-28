const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const PublicConfigVersion = require('../models/PublicConfigVersion');
const {
  buildArticleRevalidationTargets,
  notifyArticleContentInvalidation,
} = require('../services/publicContentInvalidation.service');

function mockPublicConfigVersionStore(t, initialVersion = 0) {
  const prevFindOne = PublicConfigVersion.findOne;
  const prevFindOneAndUpdate = PublicConfigVersion.findOneAndUpdate;
  const prevReadyState = mongoose.connection.readyState;

  let current = {
    key: 'public',
    version: initialVersion,
    updatedAt: new Date('2026-03-18T00:00:00.000Z'),
  };

  mongoose.connection.readyState = 1;

  PublicConfigVersion.findOne = () => ({
    lean: async () => ({ ...current }),
  });

  PublicConfigVersion.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      const next = update && update.$set ? update.$set : {};
      current = {
        key: 'public',
        version: typeof next.version === 'number' ? next.version : current.version,
        updatedAt: next.updatedAt || new Date(),
      };
      return { ...current };
    },
  });

  t.after(() => {
    PublicConfigVersion.findOne = prevFindOne;
    PublicConfigVersion.findOneAndUpdate = prevFindOneAndUpdate;
    mongoose.connection.readyState = prevReadyState;
  });
}

test('notifyArticleContentInvalidation bumps public version and emits article detail revalidation targets', async (t) => {
  mockPublicConfigVersionStore(t, 300);

  const prevFetch = global.fetch;
  process.env.PUBLIC_CONTENT_REVALIDATE_URL = 'https://example.com/revalidate';
  process.env.PUBLIC_CONTENT_REVALIDATE_TOKEN = 'test-token';

  const doc = {
    _id: '69c832dfa5f8e74cf2bf87b7',
    slug: 'source-slug',
    slugs: { en: 'source-slug', hi: 'hi-source-slug', gu: 'gu-source-slug' },
    category: 'tech',
    translationGroupId: '69c832dfa5f8e74cf2bf87b6',
    translationKey: '69c832dfa5f8e74cf2bf87b6',
  };

  const targets = buildArticleRevalidationTargets(doc);
  assert.ok(targets.paths.includes('/news/source-slug'));
  assert.ok(targets.paths.includes('/hi/news/hi-source-slug'));
  assert.ok(targets.paths.includes('/gu/news/gu-source-slug'));
  assert.ok(targets.paths.includes('/category/science-technology'));
  assert.ok(targets.paths.includes('/hi/category/science-technology'));
  assert.ok(targets.paths.includes('/gu/category/science-technology'));
  assert.ok(targets.tags.includes('article:69c832dfa5f8e74cf2bf87b7'));
  assert.ok(targets.tags.includes('translation-group:69c832dfa5f8e74cf2bf87b6'));
  assert.ok(targets.tags.includes('category:tech'));
  assert.ok(targets.tags.includes('category-page:science-technology'));

  let fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => '',
    };
  };

  t.after(() => {
    global.fetch = prevFetch;
    delete process.env.PUBLIC_CONTENT_REVALIDATE_URL;
    delete process.env.PUBLIC_CONTENT_REVALIDATE_TOKEN;
  });

  const result = await notifyArticleContentInvalidation(doc, { logger: console });

  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://example.com/revalidate');
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer test-token');

  const payload = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(payload.paths, targets.paths);
  assert.deepEqual(payload.tags, targets.tags);

  const currentVersion = await PublicConfigVersion.findOne().lean();
  assert.ok(currentVersion.version > 300);
});