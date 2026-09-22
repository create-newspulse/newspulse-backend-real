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

function makeFindOneResult(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

function getPath(obj, path) {
  return String(path || '').split('.').reduce((current, key) => (current == null ? undefined : current[key]), obj);
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).getTime();
  return value;
}

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date) && !(condition instanceof RegExp)) {
    if (Object.prototype.hasOwnProperty.call(condition, '$exists')) {
      if ((value !== undefined) !== Boolean(condition.$exists)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$ne') && value === condition.$ne) return false;
    if (Object.prototype.hasOwnProperty.call(condition, '$in') && !condition.$in.includes(value)) return false;
    if (Object.prototype.hasOwnProperty.call(condition, '$gte') && comparable(value) < comparable(condition.$gte)) return false;
    if (Object.prototype.hasOwnProperty.call(condition, '$lte') && comparable(value) > comparable(condition.$lte)) return false;
    return true;
  }
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof RegExp) return condition.test(String(value || ''));
  return value === condition;
}

function matchesFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (Array.isArray(filter.$and) && !filter.$and.every((clause) => matchesFilter(doc, clause))) return false;
  if (Array.isArray(filter.$or) && !filter.$or.some((clause) => matchesFilter(doc, clause))) return false;

  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    if (!matchesCondition(getPath(doc, key), condition)) return false;
  }
  return true;
}

function makeSpotlightArticle(id, hoursAgo, overrides = {}) {
  const publishedAt = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000));
  return {
    _id: id,
    title: `Story ${id}`,
    summary: `Summary ${id}`,
    slug: `story-${id}`,
    category: 'national',
    language: 'en',
    status: 'published',
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    deletedAt: null,
    publishAt: null,
    scheduledAt: null,
    visibility: 'public',
    isPrivate: false,
    spotlightPriority: 'normal',
    spotlightExpiresAt: null,
    coverImage: { url: `https://img.example/${id}.jpg`, alt: `Story ${id}`, publicId: null },
    ...overrides,
  };
}

function installSpotlightFindMock(docs) {
  const prevArticleFind = Article.find;
  const capturedFilters = [];
  Article.find = (filter) => {
    capturedFilters.push(filter);
    return makeFindResult(docs.filter((doc) => matchesFilter(doc, filter)));
  };
  return {
    capturedFilters,
    restore() { Article.find = prevArticleFind; },
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
        endAt: new Date('2099-05-20T00:00:00.000Z'),
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
        endAt: new Date('2099-05-20T00:00:00.000Z'),
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

test('GET /api/public/homepage/center-slot returns fresh Spotlight stories ordered by priority and recency', async () => {
  const docs = [
    makeSpotlightArticle('normal-newest', 1, { spotlightPriority: 'normal' }),
    makeSpotlightArticle('important-newer', 2, { spotlightPriority: 'important' }),
    makeSpotlightArticle('top-older', 3, { spotlightPriority: 'top' }),
    makeSpotlightArticle('important-older', 4, { spotlightPriority: 'important' }),
    makeSpotlightArticle('normal-older', 5, { spotlightPriority: 'normal' }),
    makeSpotlightArticle('normal-newer', 0.5, { spotlightPriority: 'normal' }),
    makeSpotlightArticle('tech-one', 1.5, { category: 'tech' }),
    makeSpotlightArticle('business-one', 2.5, { category: 'business' }),
  ];
  const state = installSpotlightFindMock(docs);

  try {
    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.selectedSource, 'spotlight');
    assert.equal(res.body.items.length, 8);
    assert.equal(state.capturedFilters.length, 1, '8 stories in 24 hours should use the first window only');
    assert.equal(res.body.item.article.slug, 'story-top-older');
    assert.deepEqual(res.body.items.slice(0, 5).map((item) => item.article.slug), [
      'story-top-older',
      'story-important-newer',
      'story-tech-one',
      'story-business-one',
      'story-important-older',
    ]);
  } finally {
    state.restore();
  }
});

test('GET /api/public/homepage/center-slot excludes non-public and future scheduled articles', async () => {
  const future = new Date(Date.now() + (2 * 60 * 60 * 1000));
  const docs = [
    makeSpotlightArticle('valid', 1),
    makeSpotlightArticle('draft', 1, { status: 'draft', spotlightPriority: 'top' }),
    makeSpotlightArticle('archived', 1, { status: 'archived', spotlightPriority: 'top' }),
    makeSpotlightArticle('deleted-status', 1, { status: 'deleted', spotlightPriority: 'top' }),
    makeSpotlightArticle('deleted-at', 1, { deletedAt: new Date(), spotlightPriority: 'top' }),
    makeSpotlightArticle('future-published', 1, { publishedAt: future, spotlightPriority: 'top' }),
    makeSpotlightArticle('future-publish-at', 1, { publishAt: future, spotlightPriority: 'top' }),
    makeSpotlightArticle('future-scheduled', 1, { scheduledAt: future, spotlightPriority: 'top' }),
  ];
  const state = installSpotlightFindMock(docs);

  try {
    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].article.slug, 'story-valid');
  } finally {
    state.restore();
  }
});

test('GET /api/public/homepage/center-slot expands Spotlight freshness windows to 48 and 72 hours', async () => {
  const docs = [
    ...Array.from({ length: 6 }, (_, index) => makeSpotlightArticle(`fresh-${index}`, index + 1, { category: `cat-${index}` })),
    makeSpotlightArticle('hour-30', 30, { category: 'regional' }),
    makeSpotlightArticle('hour-60', 60, { category: 'business' }),
    makeSpotlightArticle('hour-80-old', 80, { spotlightPriority: 'top', category: 'tech' }),
  ];
  const state = installSpotlightFindMock(docs);

  try {
    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(state.capturedFilters.length, 3, 'should try 24h, 48h, then 72h');
    assert.equal(res.body.items.length, 8);
    assert.ok(res.body.items.some((item) => item.article.slug === 'story-hour-30'));
    assert.ok(res.body.items.some((item) => item.article.slug === 'story-hour-60'));
    assert.ok(!res.body.items.some((item) => item.article.slug === 'story-hour-80-old'));
  } finally {
    state.restore();
  }
});

test('GET /api/public/homepage/center-slot balances categories without duplicating articles', async () => {
  const docs = [
    makeSpotlightArticle('national-1', 1, { category: 'national', spotlightPriority: 'top' }),
    makeSpotlightArticle('national-2', 2, { category: 'national', spotlightPriority: 'top' }),
    makeSpotlightArticle('national-3', 3, { category: 'national', spotlightPriority: 'top' }),
    makeSpotlightArticle('national-3', 3, { category: 'national', spotlightPriority: 'top' }),
    makeSpotlightArticle('tech-1', 1, { category: 'tech', spotlightPriority: 'important' }),
    makeSpotlightArticle('tech-2', 2, { category: 'tech', spotlightPriority: 'important' }),
    makeSpotlightArticle('business-1', 1, { category: 'business' }),
    makeSpotlightArticle('business-2', 2, { category: 'business' }),
    makeSpotlightArticle('sports-1', 1, { category: 'sports' }),
    makeSpotlightArticle('sports-2', 2, { category: 'sports' }),
  ];
  const state = installSpotlightFindMock(docs);

  try {
    const res = await request(app).get('/api/public/homepage/center-slot');
    const ids = res.body.items.map((item) => item.article.id);

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 8);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(res.body.items.slice(0, 4).map((item) => item.article.category), ['national', 'national', 'tech', 'tech']);
  } finally {
    state.restore();
  }
});

test('GET /api/public/homepage/center-slot returns a safe default card when no content is available', async () => {
  const state = installSpotlightFindMock([]);

  try {
    const res = await request(app).get('/api/public/homepage/center-slot');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.selectedSource, 'safe-default');
    assert.deepEqual(res.body.selectionOrder, ['spotlight', 'safe-default']);
    assert.equal(res.body.item.kind, 'default');
    assert.equal(res.body.item.headline, 'More stories coming soon');
    assert.deepEqual(res.body.items, []);
  } finally {
    state.restore();
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
        endAt: new Date('2099-05-20T00:00:00.000Z'),
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
        endAt: new Date('2099-05-20T00:00:00.000Z'),
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