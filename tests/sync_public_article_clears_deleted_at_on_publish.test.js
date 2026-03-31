const test = require('node:test');
const assert = require('node:assert/strict');

const PublicArticle = require('../models/Article');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');

test('syncPublicArticleFromNews clears stale deletedAt when source news is published', async () => {
  const originalFindOneAndUpdate = PublicArticle.findOneAndUpdate;

  try {
    let lastUpdate = null;

    PublicArticle.findOneAndUpdate = (_query, update) => {
      lastUpdate = update;
      return {
        lean: async () => ({ _id: 'public-1' }),
      };
    };

    await syncPublicArticleFromNews({
      _id: '69c8273fa5f8e74cf2bf7819',
      title: 'Published story',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'published-story',
      slugs: {
        en: 'published-story-en',
        hi: 'published-story-hi',
        gu: 'published-story-gu',
      },
      category: 'national',
      status: 'published',
      lang: 'gu',
      language: 'gu',
      originalLang: 'gu',
      sourceLanguage: 'gu',
      translationStatus: { en: 'ready', hi: 'ready', gu: 'ready' },
      translations: {
        en: { title: 'Published story', summary: 'Summary', content: '<p>Body</p>' },
        hi: { title: 'प्रकाशित कहानी', summary: 'सारांश', content: '<p>लेख</p>' },
        gu: { title: 'પ્રકાશિત વાર્તા', summary: 'સારાંશ', content: '<p>લેખ</p>' },
      },
      publishedAt: new Date('2026-03-31T19:04:23.859Z'),
      deletedAt: new Date('2026-03-31T17:40:39.175Z'),
    });

    assert.ok(lastUpdate);
    assert.equal(lastUpdate.$set.status, 'published');
    assert.equal(lastUpdate.$set.deletedAt, null);
  } finally {
    PublicArticle.findOneAndUpdate = originalFindOneAndUpdate;
  }
});