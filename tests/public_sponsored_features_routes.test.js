const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');
const { buildActiveSponsoredFeatureFilter } = require('../services/sponsoredFeatures.service');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeFindResult(items) {
  let rows = Array.isArray(items) ? [...items] : [];
  return {
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

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

test('GET /api/public/sponsored-feature?placement=homepage returns highest-priority active sponsored feature', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;
  let capturedFilter = null;

  try {
    SponsoredFeature.find = (filter) => {
      capturedFilter = filter;
      return makeFindResult([
      {
        _id: '507f1f77bcf86cd799439131',
        sponsorName: 'Low Priority Sponsor',
        internalTitle: 'Low',
        headline: 'Low priority feature',
        summary: 'Summary',
        ctaText: 'Read',
        destinationUrl: null,
        coverImage: { url: 'https://img.example/low.jpg', alt: 'Low', publicId: null },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        labelText: 'Sponsored Feature',
        linkedArticleId: '507f1f77bcf86cd799439133',
        linkedArticleUrl: null,
        priority: 1,
        updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      },
      {
        _id: '507f1f77bcf86cd799439132',
        sponsorName: 'Top Sponsor',
        internalTitle: 'Top',
        headline: 'Top priority feature',
        summary: 'Top summary',
        ctaText: 'Open',
        destinationUrl: null,
        coverImage: { url: 'https://img.example/top.jpg', alt: 'Top', publicId: null },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        labelText: 'Sponsored Feature',
        linkedArticleId: '507f1f77bcf86cd799439134',
        linkedArticleUrl: null,
        priority: 9,
        updatedAt: new Date('2026-04-16T00:00:00.000Z'),
      },
      ]);
    };

    Article.findOne = (filter) => {
      const id = filter && Array.isArray(filter.$or) ? String(filter.$or[0]._id) : '';
      if (id === '507f1f77bcf86cd799439134') {
        return makeFindOneResult({
          _id: id,
          title: 'Sponsored article',
          summary: 'Article summary',
          slug: 'sponsored-article',
          language: 'en',
          coverImage: { url: 'https://img.example/article.jpg', alt: 'Article', publicId: null },
          isSponsored: true,
          isSponsoredArticle: true,
          sponsorName: 'Top Sponsor',
          sponsorLabel: 'Sponsored',
          sponsorDisclosure: 'Presented by Top Sponsor',
          sponsorCtaText: 'Read full article',
          sponsorCtaUrl: 'https://example.com/sponsored',
          sponsorFeatureEligible: true,
        });
      }
      return makeFindOneResult(null);
    };

    const res = await request(app).get('/api/public/sponsored-feature?placement=homepage');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.placement, 'homepage_sponsored_feature');
    assert.deepEqual(capturedFilter, buildActiveSponsoredFeatureFilter('homepage'));
    assert.deepEqual(Object.keys(res.body.feature).sort(), ['coverImage', 'ctaText', 'headline', 'label', 'linkedArticle', 'sponsorName', 'summary', 'targetType', 'targetUrl']);
    assert.equal(res.body.feature.label, 'Sponsored Feature');
    assert.equal(res.body.feature.headline, 'Top priority feature');
    assert.equal(res.body.feature.summary, 'Top summary');
    assert.equal(res.body.feature.targetType, 'linked_article');
    assert.equal(res.body.feature.targetUrl, '/news/sponsored-article');
    assert.equal(res.body.feature.linkedArticle.slug, 'sponsored-article');
    assert.equal(res.body.feature.linkedArticle.path, '/news/sponsored-article');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/public/sponsored-feature?placement=homepage returns a null-safe response when no active feature exists', async () => {
  const prevSponsoredFind = SponsoredFeature.find;

  try {
    SponsoredFeature.find = () => makeFindResult([]);

    const res = await request(app).get('/api/public/sponsored-feature?placement=homepage');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.placement, 'homepage_sponsored_feature');
    assert.equal(res.body.placementKey, 'HOMEPAGE_SPONSORED_FEATURE');
    assert.equal(res.body.feature, null);
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
  }
});

test('GET /api/public/homepage/center-slot falls back to editor pick when no active sponsored feature exists', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([]);
    Article.findOne = (filter) => {
      const hasSpotlight = Array.isArray(filter && filter.$and) && filter.$and.some((clause) => clause && clause.spotlightEnabled === true);
      if (hasSpotlight) {
        return makeFindOneResult({
          _id: '507f1f77bcf86cd799439141',
          title: 'Editor pick title',
          summary: 'Editor pick summary',
          slug: 'editor-pick-title',
          language: 'en',
          coverImage: { url: 'https://img.example/editor.jpg', alt: 'Editor', publicId: null },
          spotlightEnabled: true,
          spotlightPinned: true,
          spotlightPriority: 7,
        });
      }
      return makeFindOneResult(null);
    };

    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.selectedSource, 'editor-pick');
    assert.deepEqual(res.body.selectionOrder, ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default']);
    assert.equal(res.body.item.labelText, `Editor's Pick`);
    assert.equal(res.body.item.article.slug, 'editor-pick-title');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/public/homepage/center-slot returns a safe default card when no content is available', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([]);
    Article.findOne = () => makeFindOneResult(null);

    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.selectedSource, 'safe-default');
    assert.deepEqual(res.body.selectionOrder, ['editor-pick', 'top-explainer', 'regional-national-fallback', 'safe-default']);
    assert.equal(res.body.item.kind, 'default');
    assert.equal(res.body.item.headline, 'More stories coming soon');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/public/sponsored-feature falls back to destinationUrl when linked article is not a sponsored article', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([
      {
        _id: '507f1f77bcf86cd799439152',
        sponsorName: 'Fallback Sponsor',
        internalTitle: 'Fallback campaign',
        headline: 'Fallback feature',
        summary: 'Fallback summary',
        ctaText: 'Visit sponsor',
        destinationUrl: 'https://example.com/fallback',
        coverImage: { url: 'https://img.example/fallback.jpg', alt: 'Fallback', publicId: null },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        labelText: 'Sponsored Feature',
        linkedArticleId: '507f1f77bcf86cd799439153',
        priority: 5,
        updatedAt: new Date('2026-04-16T00:00:00.000Z'),
      },
    ]);

    Article.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439153',
      title: 'Regular Article',
      summary: 'Editorial story',
      slug: 'regular-article',
      language: 'en',
      isSponsored: false,
      isSponsoredArticle: false,
    });

    const res = await request(app).get('/api/public/sponsored-feature?placement=homepage');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.targetType, 'external_url');
    assert.equal(res.body.feature.targetUrl, 'https://example.com/fallback');
    assert.equal(res.body.feature.linkedArticle, null);
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/public/sponsored-feature keeps homepage feature live and falls back to destinationUrl when linked sponsored article is no longer public', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([
      {
        _id: '507f1f77bcf86cd799439154',
        sponsorName: 'Reach Sponsor',
        internalTitle: 'Reach without article visibility',
        headline: 'Homepage feature remains live',
        summary: 'Feature summary',
        ctaText: 'Visit sponsor',
        destinationUrl: 'https://example.com/reach-only',
        coverImage: { url: 'https://img.example/reach.jpg', alt: 'Reach', publicId: null },
        isActive: true,
        startAt: new Date('2026-04-10T00:00:00.000Z'),
        endAt: new Date('2026-05-20T00:00:00.000Z'),
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        labelText: 'Sponsored Feature',
        linkedArticleId: '507f1f77bcf86cd799439155',
        priority: 6,
        updatedAt: new Date('2026-04-16T00:00:00.000Z'),
      },
    ]);

    Article.findOne = () => makeFindOneResult(null);

    const res = await request(app).get('/api/public/sponsored-feature?placement=homepage');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.headline, 'Homepage feature remains live');
    assert.equal(res.body.feature.targetType, 'external_url');
    assert.equal(res.body.feature.targetUrl, 'https://example.com/reach-only');
    assert.equal(res.body.feature.linkedArticle, null);
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});

test('GET /api/public/sponsored-feature?placement=homepage matches active placement-only records', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  let capturedFilter = null;

  try {
    SponsoredFeature.find = (filter) => {
      capturedFilter = filter;
      return makeFindResult([
        {
          _id: '507f1f77bcf86cd799439160',
          sponsorName: 'Legacy Placement Sponsor',
          internalTitle: 'Legacy placement only',
          headline: 'Legacy placement feature',
          summary: 'Still visible',
          ctaText: 'Visit sponsor',
          destinationUrl: 'https://example.com/legacy',
          coverImage: { url: 'https://img.example/legacy.jpg', alt: 'Legacy', publicId: null },
          isActive: true,
          startAt: null,
          endAt: null,
          placement: 'homepage_sponsored_feature',
          placementKey: null,
          labelText: 'Sponsored Feature',
          priority: 2,
          updatedAt: new Date('2026-04-20T00:00:00.000Z'),
        },
      ]);
    };

    const res = await request(app).get('/api/public/sponsored-feature?placement=homepage');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(capturedFilter, {
      isActive: true,
      $or: [
        { placementKey: 'HOMEPAGE_SPONSORED_FEATURE' },
        { placement: 'homepage_sponsored_feature' },
      ],
    });
    assert.equal(res.body.feature.headline, 'Legacy placement feature');
    assert.equal(res.body.feature.targetUrl, 'https://example.com/legacy');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
  }
});