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

function makeFindResult(items) {
  let rows = Array.isArray(items) ? [...items] : [];
  return {
    select() { return this; },
    sort(order) {
      if (order && typeof order === 'object') {
        rows.sort((left, right) => {
          for (const [field, dir] of Object.entries(order)) {
            const leftValue = left && left[field] ? new Date(left[field]).getTime() || left[field] : left && left[field];
            const rightValue = right && right[field] ? new Date(right[field]).getTime() || right[field] : right && right[field];
            if (leftValue === rightValue) continue;
            return dir < 0 ? (rightValue - leftValue) : (leftValue - rightValue);
          }
          return 0;
        });
      }
      return this;
    },
    limit() { return this; },
    lean: async () => rows,
  };
}

test('GET /api/admin/sponsored-features/:id returns a dedicated sponsored feature record', async () => {
  const featureId = '507f1f77bcf86cd799439122';
  const linkedArticleId = '507f1f77bcf86cd799439121';

  const prevFindById = SponsoredFeature.findById;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.findById = () => ({
      lean: async () => ({
        _id: featureId,
        type: 'sponsored_feature',
        placement: 'homepage_sponsored_feature',
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        sponsorName: 'Acme Corp',
        internalTitle: 'Homepage combo for Acme',
        headline: 'Acme launches something new',
        summary: 'Premium placement summary',
        ctaText: 'Read Sponsored Story',
        destinationUrl: 'https://example.com/landing',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card', publicId: null },
        linkedArticleId,
        comboCampaign: { isActive: true },
        isActive: true,
        startAt: new Date('2026-04-16T10:00:00.000Z'),
        endAt: new Date('2026-05-16T10:00:00.000Z'),
        createdAt: new Date('2026-04-16T10:00:00.000Z'),
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
      }),
    });
    Article.findOne = () => makeFindOneResult({
      _id: linkedArticleId,
      title: 'Sponsored Article',
      summary: 'Article summary',
      slug: 'sponsored-article',
      language: 'en',
      coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
      isSponsored: true,
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorLabel: 'Sponsored',
      sponsorDisclosure: 'Presented by Acme Corp',
      sponsorCtaText: 'Read More',
      sponsorCtaUrl: 'https://example.com/article',
      sponsorFeatureEligible: true,
    });

    const res = await request(app)
      .get(`/api/admin/sponsored-features/${featureId}`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.id, featureId);
    assert.equal(res.body.feature.type, 'sponsored_feature');
    assert.equal(res.body.feature.placement, 'homepage_sponsored_feature');
    assert.equal(res.body.feature.linkedSponsoredArticleId, linkedArticleId);
    assert.equal(res.body.feature.comboCampaignIsActive, true);
    assert.equal(res.body.feature.commercialState.sponsoredFeature.product, 'sponsored_feature');
    assert.equal(res.body.feature.commercialState.sponsoredFeature.homepagePlacementOnly, true);
    assert.equal(res.body.feature.commercialState.sponsoredArticle.product, 'sponsored_article');
    assert.equal(res.body.feature.commercialState.comboCampaign.product, 'combo_campaign');
    assert.equal(res.body.feature.commercialState.comboCampaign.isFrontendObject, false);
  } finally {
    SponsoredFeature.findById = prevFindById;
    Article.findOne = prevArticleFindOne;
  }
});

test('POST /api/admin/sponsored-features creates a combo feature linked to a published article', async () => {
  const linkedArticleId = '507f1f77bcf86cd799439121';
  const featureId = '507f1f77bcf86cd799439122';

  const prevCreate = SponsoredFeature.create;
  const prevUpdateMany = SponsoredFeature.updateMany;
  const prevArticleFindOne = Article.findOne;
  const prevArticleUpdateMany = Article.updateMany;
  const prevNewsUpdateMany = News.updateMany;
  const deactivateCalls = [];

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
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorLabel: 'Sponsored',
      sponsorDisclosure: 'Presented by Acme Corp',
      sponsorCtaText: 'Read More',
      sponsorCtaUrl: 'https://example.com/article',
      sponsorFeatureEligible: true,
    });
    Article.updateMany = async () => ({ acknowledged: true });
    News.updateMany = async () => ({ acknowledged: true });
    SponsoredFeature.updateMany = async (filter, update) => {
      deactivateCalls.push({ filter, update });
      return { acknowledged: true };
    };

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
        internalCampaignName: 'Homepage combo for Acme',
        headline: 'Acme launches something new',
        shortSummary: 'Premium placement summary',
        ctaText: 'Read Sponsored Story',
        placement: 'homepage',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card' },
        linkedSponsoredArticleId: linkedArticleId,
        isActive: true,
        priority: 10,
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.id, featureId);
    assert.equal(res.body.feature.type, 'sponsored_feature');
    assert.equal(res.body.feature.placement, 'homepage_sponsored_feature');
    assert.equal(res.body.feature.placementKey, 'HOMEPAGE_SPONSORED_FEATURE');
    assert.equal(res.body.feature.linkedArticleId, linkedArticleId);
    assert.equal(res.body.feature.linkedSponsoredArticleId, linkedArticleId);
    assert.equal(res.body.feature.comboCampaignIsActive, true);
    assert.equal(res.body.feature.internalCampaignName, 'Homepage combo for Acme');
    assert.equal(res.body.feature.shortSummary, 'Premium placement summary');
    assert.equal(res.body.feature.linkedArticle.slug, 'sponsored-article');
    assert.equal(res.body.feature.linkedArticle.apiUrl, '/api/public/news/sponsored-article');
    assert.equal(res.body.feature.commercialState.comboCampaign.isActive, true);
    assert.equal(res.body.feature.commercialState.comboCampaign.components.sponsoredFeatureLive, true);
    assert.equal(res.body.feature.commercialState.comboCampaign.components.sponsoredArticleLive, true);
    assert.equal(deactivateCalls.length, 1);
    assert.deepEqual(deactivateCalls[0].filter, {
      isActive: true,
      _id: { $ne: featureId },
      $or: [
        { placementKey: 'HOMEPAGE_SPONSORED_FEATURE' },
        { placement: 'homepage_sponsored_feature' },
      ],
    });
    assert.deepEqual(deactivateCalls[0].update, { $set: { isActive: false } });
  } finally {
    SponsoredFeature.create = prevCreate;
    SponsoredFeature.updateMany = prevUpdateMany;
    Article.findOne = prevArticleFindOne;
    Article.updateMany = prevArticleUpdateMany;
    News.updateMany = prevNewsUpdateMany;
  }
});

test('PATCH /api/admin/sponsored-features/:id/toggle turns off only the homepage feature and leaves sponsored article live', async () => {
  const featureId = '507f1f77bcf86cd799439194';
  const linkedArticleId = '507f1f77bcf86cd799439195';
  const prevFindById = SponsoredFeature.findById;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.findById = async (id) => {
      if (String(id) !== featureId) return null;
      return {
        _id: featureId,
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        placement: 'homepage_sponsored_feature',
        sponsorName: 'Acme Corp',
        internalTitle: 'Homepage reach only',
        headline: 'Reach campaign',
        summary: 'Feature summary',
        ctaText: 'Read Sponsored Story',
        destinationUrl: 'https://example.com/landing',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card', publicId: null },
        linkedArticleId,
        comboCampaign: { isActive: true },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        save: async function save() { return this; },
      };
    };

    let articleFindCalls = 0;
    Article.findOne = () => {
      articleFindCalls += 1;
      return makeFindOneResult({
        _id: linkedArticleId,
        title: 'Sponsored Article',
        summary: 'Article summary',
        slug: 'sponsored-article',
        language: 'en',
        coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
        isSponsored: true,
        isSponsoredArticle: true,
        sponsorName: 'Acme Corp',
        sponsorFeatureEligible: true,
        publishedAt: new Date('2026-04-15T10:00:00.000Z'),
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
      });
    };

    const res = await request(app)
      .patch(`/api/admin/sponsored-features/${featureId}/toggle`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ isActive: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.feature.isActive, false);
    assert.equal(res.body.feature.linkedArticle.slug, 'sponsored-article');
    assert.equal(res.body.feature.commercialState.sponsoredFeature.isLive, false);
    assert.equal(res.body.feature.commercialState.sponsoredArticle.isLive, true);
    assert.equal(res.body.feature.commercialState.comboCampaign.isActive, false);
    assert.ok(articleFindCalls >= 2);
  } finally {
    SponsoredFeature.findById = prevFindById;
    Article.findOne = prevArticleFindOne;
  }
});

test('PATCH /api/admin/sponsored-features/:id/combo-toggle turns off only the combo bundle and keeps the feature record active', async () => {
  const featureId = '507f1f77bcf86cd799439196';
  const linkedArticleId = '507f1f77bcf86cd799439197';
  const prevFindById = SponsoredFeature.findById;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.findById = async (id) => {
      if (String(id) !== featureId) return null;
      return {
        _id: featureId,
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        placement: 'homepage_sponsored_feature',
        sponsorName: 'Acme Corp',
        internalTitle: 'Homepage combo bundle',
        headline: 'Combo campaign',
        summary: 'Feature summary',
        ctaText: 'Read Sponsored Story',
        destinationUrl: 'https://example.com/landing',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card', publicId: null },
        linkedArticleId,
        comboCampaign: { isActive: true },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        save: async function save() { return this; },
      };
    };

    Article.findOne = () => makeFindOneResult({
      _id: linkedArticleId,
      title: 'Sponsored Article',
      summary: 'Article summary',
      slug: 'sponsored-article',
      language: 'en',
      coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
      isSponsored: true,
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorFeatureEligible: true,
      publishedAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-16T10:00:00.000Z'),
    });

    const res = await request(app)
      .patch(`/api/admin/sponsored-features/${featureId}/combo-toggle`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ isActive: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.feature.isActive, true);
    assert.equal(res.body.feature.comboCampaignIsActive, false);
    assert.equal(res.body.feature.commercialState.sponsoredFeature.isLive, true);
    assert.equal(res.body.feature.commercialState.sponsoredArticle.isLive, true);
    assert.equal(res.body.feature.commercialState.comboCampaign.isEnabled, false);
    assert.equal(res.body.feature.commercialState.comboCampaign.isActive, false);
  } finally {
    SponsoredFeature.findById = prevFindById;
    Article.findOne = prevArticleFindOne;
  }
});

test('POST /api/admin/sponsored-features rejects invalid linkedSponsoredArticleId alias', async () => {
  const res = await request(app)
    .post('/api/admin/sponsored-features')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      sponsorName: 'Acme Corp',
      internalCampaignName: 'Homepage combo for Acme',
      headline: 'Acme launches something new',
      shortSummary: 'Premium placement summary',
      ctaText: 'Read Sponsored Story',
      placement: 'homepage',
      coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card' },
      destinationUrl: 'https://example.com/landing',
      linkedSponsoredArticleId: 'not-a-real-id',
      isActive: true,
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'linkedArticleId must be a valid id');
});

test('POST /api/admin/sponsored-features rejects linking a non-sponsored article', async () => {
  const linkedArticleId = '507f1f77bcf86cd799439121';
  const prevArticleFindOne = Article.findOne;

  try {
    Article.findOne = () => makeFindOneResult({
      _id: linkedArticleId,
      title: 'Regular Article',
      summary: 'Editorial summary',
      slug: 'regular-article',
      language: 'en',
      isSponsored: false,
      isSponsoredArticle: false,
    });

    const res = await request(app)
      .post('/api/admin/sponsored-features')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        sponsorName: 'Acme Corp',
        internalCampaignName: 'Homepage combo for Acme',
        headline: 'Acme launches something new',
        shortSummary: 'Premium placement summary',
        ctaText: 'Read Sponsored Story',
        placement: 'homepage',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card' },
        linkedSponsoredArticleId: linkedArticleId,
        isActive: true,
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.message, 'linkedArticleId must reference a published sponsored article');
  } finally {
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/admin/sponsored-features/dashboard returns list, active count, live target, and eligible sponsored articles', async () => {
  const featureId = '507f1f77bcf86cd799439191';
  const linkedArticleId = '507f1f77bcf86cd799439192';
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFind = Article.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([
      {
        _id: featureId,
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        placement: 'homepage_sponsored_feature',
        sponsorName: 'Acme Corp',
        internalTitle: 'Homepage combo for Acme',
        headline: 'Acme launches something new',
        summary: 'Premium placement summary',
        ctaText: 'Read Sponsored Story',
        destinationUrl: 'https://example.com/landing',
        coverImage: { url: 'https://img.example/feature.jpg', alt: 'Feature card', publicId: null },
        linkedArticleId,
        comboCampaign: { isActive: true },
        isActive: true,
        priority: 10,
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
      },
    ]);
    Article.findOne = () => makeFindOneResult({
      _id: linkedArticleId,
      title: 'Sponsored Article',
      summary: 'Article summary',
      slug: 'sponsored-article',
      language: 'en',
      coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
      isSponsored: true,
      isSponsoredArticle: true,
      sponsorName: 'Acme Corp',
      sponsorFeatureEligible: true,
      publishedAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-16T10:00:00.000Z'),
    });
    Article.find = () => makeFindResult([
      {
        _id: linkedArticleId,
        title: 'Sponsored Article',
        summary: 'Article summary',
        slug: 'sponsored-article',
        language: 'en',
        coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
        isSponsored: true,
        isSponsoredArticle: true,
        sponsorName: 'Acme Corp',
        sponsorFeatureEligible: true,
        sponsorFeatureLinkedId: featureId,
        publishedAt: new Date('2026-04-15T10:00:00.000Z'),
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
      },
    ]);

    const res = await request(app)
      .get('/api/admin/sponsored-features/dashboard')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.activeCount, 1);
    assert.equal(Array.isArray(res.body.items), true);
    assert.equal(Array.isArray(res.body.eligibleSponsoredArticles), true);
    assert.equal(res.body.items[0].id, featureId);
    assert.equal(res.body.liveTarget.featureId, featureId);
    assert.equal(res.body.liveTarget.targetType, 'linked_article');
    assert.equal(res.body.liveTarget.targetUrl, '/news/sponsored-article');
    assert.equal(res.body.eligibleSponsoredArticles[0].id, linkedArticleId);
    assert.equal(res.body.eligibleSponsoredArticles[0].path, '/news/sponsored-article');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.find = prevArticleFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/admin/sponsored-features/eligible-articles lists published sponsored articles', async () => {
  const linkedArticleId = '507f1f77bcf86cd799439193';
  const prevArticleFind = Article.find;

  try {
    Article.find = () => makeFindResult([
      {
        _id: linkedArticleId,
        title: 'Eligible Sponsored Article',
        slug: 'eligible-sponsored-article',
        language: 'en',
        isSponsored: true,
        isSponsoredArticle: true,
        sponsorName: 'Acme Corp',
        sponsorFeatureEligible: false,
        publishedAt: new Date('2026-04-15T10:00:00.000Z'),
        updatedAt: new Date('2026-04-16T10:00:00.000Z'),
        coverImage: { url: 'https://img.example/article-2.jpg', alt: 'Article', publicId: null },
      },
    ]);

    const res = await request(app)
      .get('/api/admin/sponsored-features/eligible-articles')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(Array.isArray(res.body.items), true);
    assert.equal(res.body.items[0].id, linkedArticleId);
    assert.equal(res.body.items[0].slug, 'eligible-sponsored-article');
    assert.equal(res.body.items[0].path, '/news/eligible-sponsored-article');
  } finally {
    Article.find = prevArticleFind;
  }
});