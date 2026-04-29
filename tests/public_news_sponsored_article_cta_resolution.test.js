const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const News = require('../models/News');
const Article = require('../models/Article');
const SponsoredFeature = require('../models/SponsoredFeature');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

function withDbReady(fn) {
  return async () => {
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    });

    try {
      await fn();
    } finally {
      if (descriptor) {
        Object.defineProperty(mongoose.connection, 'readyState', descriptor);
      } else {
        delete mongoose.connection.readyState;
      }
    }
  };
}

test('GET /api/public/news/:slugOrId resolves sponsored CTA from article-level fields before linked feature fallback', { concurrency: false }, withDbReady(async () => {
  const prevNewsFindOne = News.findOne;
  const prevFeatureFindById = SponsoredFeature.findById;
  const prevArticleFindOne = Article.findOne;

  try {
    News.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439250',
      title: 'Sponsored story',
      description: 'Sponsored summary',
      content: '<p>Sponsored content</p>',
      slug: 'sponsored-story',
      slugs: { en: 'sponsored-story' },
      category: 'national',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      isSponsored: true,
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorDisclosure: 'Presented by Acme Corp',
      sponsorCtaText: 'Read Case Study',
      sponsorDestinationUrl: 'https://example.com/article-cta',
      sponsorFeatureLinkedId: '507f1f77bcf86cd799439251',
      publishedAt: new Date('2026-04-23T09:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-04-23T10:00:00.000Z').toISOString(),
      translations: {},
      translationStatus: {},
    });

    SponsoredFeature.findById = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439251',
      sponsorName: 'Acme Corp',
      headline: 'Feature headline',
      ctaText: 'Visit feature page',
      destinationUrl: 'https://example.com/feature-cta',
      linkedArticleId: '507f1f77bcf86cd799439250',
      comboCampaign: { isActive: true },
      isActive: true,
      startAt: new Date('2026-04-22T09:00:00.000Z'),
      endAt: new Date('2099-04-24T09:00:00.000Z'),
    });

    Article.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439250',
      sourceNewsId: '507f1f77bcf86cd799439250',
      slug: 'sponsored-story',
      language: 'en',
      title: 'Sponsored story',
      isSponsored: true,
      isSponsoredArticle: true,
      publishedAt: new Date('2026-04-23T09:00:00.000Z'),
    });

    const res = await request(app).get('/api/public/news/sponsored-story?lang=en');

    assert.equal(res.status, 200);
    assert.equal(res.body.sponsorName, 'Acme Corp');
    assert.equal(res.body.sponsorCtaText, 'Read Case Study');
    assert.equal(res.body.sponsorDestinationUrl, 'https://example.com/article-cta');
    assert.equal(res.body.sponsorCtaUrl, 'https://example.com/article-cta');
    assert.equal(res.body.resolvedSponsorCtaText, 'Read Case Study');
    assert.equal(res.body.resolvedSponsorDestinationUrl, 'https://example.com/article-cta');
    assert.equal(res.body.resolvedSponsorCtaSource, 'article');
    assert.equal(res.body.linkedSponsoredFeature.destinationUrl, 'https://example.com/feature-cta');
  } finally {
    News.findOne = prevNewsFindOne;
    SponsoredFeature.findById = prevFeatureFindById;
    Article.findOne = prevArticleFindOne;
  }
}));

test('GET /api/public/news/:slugOrId falls back to a live linked sponsored feature CTA when article-level CTA is absent', { concurrency: false }, withDbReady(async () => {
  const prevNewsFindOne = News.findOne;
  const prevFeatureFindById = SponsoredFeature.findById;
  const prevArticleFindOne = Article.findOne;

  try {
    News.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439260',
      title: 'Sponsored story',
      description: 'Sponsored summary',
      content: '<p>Sponsored content</p>',
      slug: 'sponsored-story-fallback',
      slugs: { en: 'sponsored-story-fallback' },
      category: 'national',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      isSponsored: true,
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorFeatureLinkedId: '507f1f77bcf86cd799439261',
      publishedAt: new Date('2026-04-23T09:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-04-23T10:00:00.000Z').toISOString(),
      translations: {},
      translationStatus: {},
    });

    SponsoredFeature.findById = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439261',
      sponsorName: 'Acme Corp',
      headline: 'Feature headline',
      ctaText: 'Visit feature page',
      destinationUrl: 'https://example.com/feature-cta',
      linkedArticleId: '507f1f77bcf86cd799439260',
      comboCampaign: { isActive: true },
      isActive: true,
      startAt: new Date('2026-04-22T09:00:00.000Z'),
      endAt: new Date('2099-04-24T09:00:00.000Z'),
    });

    Article.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439260',
      sourceNewsId: '507f1f77bcf86cd799439260',
      slug: 'sponsored-story-fallback',
      language: 'en',
      title: 'Sponsored story',
      isSponsored: true,
      isSponsoredArticle: true,
      publishedAt: new Date('2026-04-23T09:00:00.000Z'),
    });

    const res = await request(app).get('/api/public/news/sponsored-story-fallback?lang=en');

    assert.equal(res.status, 200);
    assert.equal(res.body.sponsorCtaText, null);
    assert.equal(res.body.sponsorDestinationUrl, null);
    assert.equal(res.body.resolvedSponsorCtaText, 'Visit feature page');
    assert.equal(res.body.resolvedSponsorDestinationUrl, 'https://example.com/feature-cta');
    assert.equal(res.body.resolvedSponsorCtaSource, 'linked_feature');
  } finally {
    News.findOne = prevNewsFindOne;
    SponsoredFeature.findById = prevFeatureFindById;
    Article.findOne = prevArticleFindOne;
  }
}));