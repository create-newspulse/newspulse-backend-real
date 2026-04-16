const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');
const News = require('../models/News');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

test('POST /api/admin/sponsored-features creates a combo feature linked to a published article', async () => {
  const linkedArticleId = '507f1f77bcf86cd799439121';
  const featureId = '507f1f77bcf86cd799439122';

  const prevCreate = SponsoredFeature.create;
  const prevArticleFindOne = Article.findOne;
  const prevArticleUpdateMany = Article.updateMany;
  const prevNewsUpdateMany = News.updateMany;

  try {
    Article.findOne = () => makeFindOneResult({
      _id: linkedArticleId,
      sourceNewsId: '507f1f77bcf86cd799439123',
      title: 'Sponsored Article',
      summary: 'Article summary',
      slug: 'sponsored-article',
      language: 'en',
      coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
      isSponsored: true,
      sponsorName: 'Acme Corp',
      sponsorLabel: 'Sponsored',
      sponsorDisclosure: 'Presented by Acme Corp',
      sponsorCtaText: 'Read More',
      sponsorCtaUrl: 'https://example.com/article',
      sponsorFeatureEligible: true,
    });
    Article.updateMany = async () => ({ acknowledged: true });
    News.updateMany = async () => ({ acknowledged: true });

    SponsoredFeature.create = async (payload) => ({
      _id: featureId,
      ...payload,
      createdAt: new Date('2026-04-16T10:00:00.000Z'),
      updatedAt: new Date('2026-04-16T10:00:00.000Z'),
    });

    const res = await request(app)
      .post('/api/admin/sponsored-features')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        sponsorName: 'Acme Corp',
        internalTitle: 'Homepage combo for Acme',
        headline: 'Acme launches something new',
        summary: 'Premium placement summary',
        ctaText: 'Read Sponsored Story',
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card' },
        linkedArticleId,
        isActive: true,
        priority: 10,
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.id, featureId);
    assert.equal(res.body.feature.placementKey, 'HOMEPAGE_SPONSORED_FEATURE');
    assert.equal(res.body.feature.linkedArticleId, linkedArticleId);
    assert.equal(res.body.feature.linkedArticle.slug, 'sponsored-article');
    assert.equal(res.body.feature.linkedArticle.apiUrl, '/api/public/news/sponsored-article');
  } finally {
    SponsoredFeature.create = prevCreate;
    Article.findOne = prevArticleFindOne;
    Article.updateMany = prevArticleUpdateMany;
    News.updateMany = prevNewsUpdateMany;
  }
});