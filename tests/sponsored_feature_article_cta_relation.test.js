const test = require('node:test');
const assert = require('node:assert/strict');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');
const { getLinkedSponsoredFeatureForArticle } = require('../services/sponsoredFeatures.service');

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
  };
}

function makeFindByIdResult(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
  };
}

test('getLinkedSponsoredFeatureForArticle returns null when the feature does not really link back to the current article', async () => {
  const prevFindById = SponsoredFeature.findById;
  const prevFindOne = Article.findOne;

  try {
    SponsoredFeature.findById = () => makeFindByIdResult({
      _id: '507f1f77bcf86cd799439150',
      sponsorName: 'Acme Brand',
      headline: 'Feature headline',
      ctaText: 'Visit feature page',
      destinationUrl: 'https://acme.example.com/feature',
      linkedArticleId: '507f1f77bcf86cd799439199',
      comboCampaign: { isActive: true },
      isActive: true,
    });
    Article.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439199',
      sourceNewsId: '507f1f77bcf86cd799439199',
      slug: 'different-story',
      language: 'en',
      title: 'Different story',
      isSponsored: true,
      isSponsoredArticle: true,
      publishedAt: new Date('2026-04-23T10:00:00.000Z'),
    });

    const relation = await getLinkedSponsoredFeatureForArticle({
      _id: '507f1f77bcf86cd799439123',
      sourceNewsId: '507f1f77bcf86cd799439123',
      sponsorFeatureLinkedId: '507f1f77bcf86cd799439150',
      isSponsored: true,
      isSponsoredArticle: true,
    });

    assert.equal(relation, null);
  } finally {
    SponsoredFeature.findById = prevFindById;
    Article.findOne = prevFindOne;
  }
});

test('getLinkedSponsoredFeatureForArticle returns linked feature CTA data only for a real combo relation', async () => {
  const prevFindById = SponsoredFeature.findById;
  const prevFindOne = Article.findOne;

  try {
    SponsoredFeature.findById = () => makeFindByIdResult({
      _id: '507f1f77bcf86cd799439151',
      sponsorName: 'Acme Brand',
      headline: 'Feature headline',
      ctaText: 'Visit feature page',
      destinationUrl: 'https://acme.example.com/feature',
      linkedArticleId: '507f1f77bcf86cd799439123',
      comboCampaign: { isActive: true },
      isActive: false,
    });
    Article.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439123',
      sourceNewsId: '507f1f77bcf86cd799439123',
      slug: 'sponsored-story',
      language: 'en',
      title: 'Sponsored story',
      isSponsored: true,
      isSponsoredArticle: true,
      publishedAt: new Date('2026-04-23T10:00:00.000Z'),
    });

    const relation = await getLinkedSponsoredFeatureForArticle({
      _id: '607f1f77bcf86cd799439123',
      sourceNewsId: '507f1f77bcf86cd799439123',
      sponsorFeatureLinkedId: '507f1f77bcf86cd799439151',
      isSponsored: true,
      isSponsoredArticle: true,
    });

    assert.ok(relation);
    assert.equal(relation.id, '507f1f77bcf86cd799439151');
    assert.equal(relation.ctaText, 'Visit feature page');
    assert.equal(relation.destinationUrl, 'https://acme.example.com/feature');
    assert.equal(relation.linkedArticleId, '507f1f77bcf86cd799439123');
    assert.equal(relation.linkedArticleSlug, 'sponsored-story');
    assert.equal(relation.comboCampaignIsActive, true);
  } finally {
    SponsoredFeature.findById = prevFindById;
    Article.findOne = prevFindOne;
  }
});