const test = require('node:test');
const assert = require('node:assert/strict');

const PublicArticle = require('../models/Article');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');

test('syncPublicArticleFromNews copies sponsored article fields to the public article', async () => {
  const originalFindOneAndUpdate = PublicArticle.findOneAndUpdate;

  try {
    let lastUpdate = null;

    PublicArticle.findOneAndUpdate = (_query, update) => {
      lastUpdate = update;
      return {
        lean: async () => ({ _id: 'public-sponsored-1' }),
      };
    };

    await syncPublicArticleFromNews({
      _id: '69c8273fa5f8e74cf2bf7830',
      title: 'Sponsored story',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'sponsored-story',
      category: 'national',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      isSponsored: true,
      sponsorName: 'Acme Corp',
      sponsorLabel: 'Sponsored',
      sponsorDisclosure: 'Presented by Acme Corp',
      sponsorCtaText: 'Learn More',
      sponsorCtaUrl: 'https://example.com/sponsored',
      sponsorFeatureEligible: true,
      sponsorFeatureLinkedId: '507f1f77bcf86cd799439151',
      publishedAt: new Date('2026-04-16T09:30:00.000Z'),
    });

    assert.ok(lastUpdate);
    assert.equal(lastUpdate.$set.isSponsored, true);
    assert.equal(lastUpdate.$set.sponsorName, 'Acme Corp');
    assert.equal(lastUpdate.$set.sponsorLabel, 'Sponsored');
    assert.equal(lastUpdate.$set.sponsorDisclosure, 'Presented by Acme Corp');
    assert.equal(lastUpdate.$set.sponsorCtaText, 'Learn More');
    assert.equal(lastUpdate.$set.sponsorCtaUrl, 'https://example.com/sponsored');
    assert.equal(lastUpdate.$set.sponsorFeatureEligible, true);
    assert.equal(String(lastUpdate.$set.sponsorFeatureLinkedId), '507f1f77bcf86cd799439151');
  } finally {
    PublicArticle.findOneAndUpdate = originalFindOneAndUpdate;
  }
});