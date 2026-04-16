const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const SponsoredFeature = require('../models/SponsoredFeature');
const Article = require('../models/Article');

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

test('GET /api/public/sponsored-features/slot/:placementKey returns highest-priority active sponsored feature', async () => {
  const prevSponsoredFind = SponsoredFeature.find;
  const prevArticleFindOne = Article.findOne;

  try {
    SponsoredFeature.find = () => makeFindResult([
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
        endAt: new Date('2026-04-20T00:00:00.000Z'),
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
        endAt: new Date('2026-04-20T00:00:00.000Z'),
        placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
        labelText: 'Sponsored Feature',
        linkedArticleId: '507f1f77bcf86cd799439134',
        linkedArticleUrl: null,
        priority: 9,
        updatedAt: new Date('2026-04-16T00:00:00.000Z'),
      },
    ]);

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

    const res = await request(app).get('/api/public/sponsored-features/slot/HOMEPAGE_SPONSORED_FEATURE');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.feature.id, '507f1f77bcf86cd799439132');
    assert.equal(res.body.feature.headline, 'Top priority feature');
    assert.equal(res.body.feature.effectiveDestinationUrl, '/api/public/news/sponsored-article');
    assert.equal(res.body.feature.linkedArticle.slug, 'sponsored-article');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
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
    assert.equal(res.body.item.kind, 'default');
    assert.equal(res.body.item.headline, 'More stories coming soon');
  } finally {
    SponsoredFeature.find = prevSponsoredFind;
    Article.findOne = prevArticleFindOne;
  }
});