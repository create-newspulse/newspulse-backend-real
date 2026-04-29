const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SystemSetting = require('../models/SystemSetting');
const ViralVideo = require('../models/ViralVideo');

function enableViralVideosSetting() {
  return {
    value: {
      frontendEnabled: true,
    },
  };
}

function disableViralVideosSetting() {
  return {
    value: {
      frontendEnabled: false,
    },
  };
}

function makeFindResult(items) {
  let rows = Array.isArray(items) ? [...items] : [];

  return {
    sort(order) {
      if (order && typeof order === 'object') {
        rows.sort((left, right) => {
          for (const [field, dir] of Object.entries(order)) {
            const leftValue = left && left[field] instanceof Date ? left[field].getTime() : left && left[field];
            const rightValue = right && right[field] instanceof Date ? right[field].getTime() : right && right[field];
            if (leftValue === rightValue) continue;
            if (dir < 0) return leftValue > rightValue ? -1 : 1;
            return leftValue < rightValue ? -1 : 1;
          }
          return 0;
        });
      }
      return this;
    },
    skip(count) {
      rows = rows.slice(count);
      return this;
    },
    limit(count) {
      rows = rows.slice(0, count);
      return this;
    },
    lean: async () => rows,
  };
}

function makeFindOneResult(doc) {
  return {
    lean: async () => doc,
  };
}

function createVideo(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439301',
    title: overrides.title || 'Viral clip',
    slug: overrides.slug || 'viral-clip',
    summary: overrides.summary || 'Short summary',
    thumbnailUrl: overrides.thumbnailUrl,
    posterImage: overrides.posterImage || { url: 'https://img.example/video.jpg', alt: 'Poster', publicId: null },
    videoUrl: overrides.videoUrl !== undefined ? overrides.videoUrl : null,
    embedUrl: overrides.embedUrl !== undefined ? overrides.embedUrl : 'https://www.youtube.com/embed/demo',
    sourceType: overrides.sourceType || 'embed',
    language: overrides.language || 'en',
    category: overrides.category || 'funny',
    tags: overrides.tags || ['cats'],
    isPublished: overrides.isPublished !== undefined ? overrides.isPublished : true,
    status: overrides.status,
    isHomepageVisible: overrides.isHomepageVisible !== undefined ? overrides.isHomepageVisible : true,
    homepageFeatured: overrides.homepageFeatured,
    isFeaturedHomepage: overrides.isFeaturedHomepage !== undefined ? overrides.isFeaturedHomepage : (overrides.isFeatured !== undefined ? overrides.isFeatured : false),
    isFeatured: overrides.isFeatured !== undefined ? overrides.isFeatured : false,
    publishedAt: overrides.publishedAt || new Date('2026-04-24T10:00:00.000Z'),
    createdAt: overrides.createdAt || new Date('2026-04-24T09:00:00.000Z'),
    updatedAt: overrides.updatedAt || new Date('2026-04-24T09:30:00.000Z'),
    sortOrder: overrides.sortOrder !== undefined ? overrides.sortOrder : 0,
  };
}

function expectedFeaturedHomepageFilter() {
  const nonEmptyString = { $type: 'string', $ne: '' };

  return {
    $and: [
      {
        $or: [
          { isPublished: true },
          { status: 'published' },
        ],
      },
      {
        $or: [
          { isFeatured: true },
          { homepageFeatured: true },
          { isFeaturedHomepage: true },
        ],
      },
      {
        $or: [
          { thumbnailUrl: nonEmptyString },
          { 'posterImage.url': nonEmptyString },
          { 'thumbnail.url': nonEmptyString },
          { videoUrl: nonEmptyString },
          { 'uploadedVideo.url': nonEmptyString },
          { 'uploadedVideo.relativeUrl': nonEmptyString },
          { embedUrl: nonEmptyString },
        ],
      },
    ],
  };
}

test('GET /api/public/viral-videos returns paginated published archive items', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };
  let capturedFilter = null;

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilter = filter;
      return makeFindResult([
        createVideo({ _id: '507f1f77bcf86cd799439301', slug: 'latest-viral', publishedAt: new Date('2026-04-25T10:00:00.000Z') }),
        createVideo({ _id: '507f1f77bcf86cd799439302', slug: 'older-viral', publishedAt: new Date('2026-04-24T10:00:00.000Z') }),
      ]);
    };
    ViralVideo.countDocuments = async (filter) => {
      capturedFilter = filter;
      return 2;
    };

    const res = await request(app).get('/api/public/viral-videos?limit=2&page=1&lang=en&category=funny&tag=cats');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.items[0].slug, 'latest-viral');
    assert.equal(res.body.items[0].isHomepageVisible, true);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.totalPages, 1);
    assert.deepEqual(res.body.filters, { lang: 'en', category: 'funny', year: null, month: null, tag: 'cats' });
    assert.deepEqual(capturedFilter, {
      isPublished: true,
      publishedAt: { $ne: null },
      language: 'en',
      category: 'funny',
      tags: 'cats',
    });
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns record saved with homepageFeatured status fields', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  const capturedFilters = [];

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilters.push(filter);
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439333',
          slug: 'homepage-featured-fields',
          title: 'Homepage Featured Fields',
          posterImage: { url: null, alt: null, publicId: null },
          thumbnailUrl: 'https://img.example/homepage-featured.jpg',
          videoUrl: 'https://cdn.example/homepage-featured.mp4',
          embedUrl: null,
          language: 'gu',
          isPublished: false,
          status: 'published',
          isFeatured: false,
          isFeaturedHomepage: false,
          homepageFeatured: true,
        }),
      ]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      ok: true,
      settings: { frontendEnabled: true },
      video: {
        _id: '507f1f77bcf86cd799439333',
        title: 'Homepage Featured Fields',
        slug: 'homepage-featured-fields',
        thumbnailUrl: 'https://img.example/homepage-featured.jpg',
        videoUrl: 'https://cdn.example/homepage-featured.mp4',
        language: 'gu',
        status: 'published',
        homepageFeatured: true,
      },
    });
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos still returns published items that are hidden from homepage', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = () => makeFindResult([
      createVideo({
        _id: '507f1f77bcf86cd799439350',
        slug: 'archive-only-viral',
        isHomepageVisible: false,
      }),
    ]);
    ViralVideo.countDocuments = async () => 1;

    const res = await request(app).get('/api/public/viral-videos?limit=1&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].slug, 'archive-only-viral');
    assert.equal(res.body.items[0].isHomepageVisible, false);
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
  }
});

test('GET /api/public/viral-videos returns an empty archive payload when global viral videos visibility is off', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };

  try {
    SystemSetting.findOne = () => ({ lean: async () => disableViralVideosSetting() });
    ViralVideo.find = () => {
      throw new Error('archive query should not run when viral videos are disabled');
    };
    ViralVideo.countDocuments = async () => {
      throw new Error('archive count should not run when viral videos are disabled');
    };

    const res = await request(app).get('/api/public/viral-videos?limit=1&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.total, 0);
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns homepage featured video response', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  const capturedFilters = [];

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilters.push(filter);
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439303',
          slug: 'featured-viral',
          title: 'Featured Viral',
          videoUrl: 'https://cdn.example/featured-viral.mp4',
          embedUrl: null,
          language: 'gu',
          isFeatured: true,
          isFeaturedHomepage: true,
          sortOrder: 10,
        }),
      ]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.settings, { frontendEnabled: true });
    assert.deepEqual(res.body.video, {
      _id: '507f1f77bcf86cd799439303',
      title: 'Featured Viral',
      slug: 'featured-viral',
      thumbnailUrl: 'https://img.example/video.jpg',
      videoUrl: 'https://cdn.example/featured-viral.mp4',
      language: 'gu',
      status: 'published',
      homepageFeatured: true,
    });
    assert.deepEqual(capturedFilters[0], expectedFeaturedHomepageFilter());
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns null video when no featured-homepage item exists', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  const capturedFilters = [];

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilters.push(filter);
      return makeFindResult([]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.settings, { frontendEnabled: true });
    assert.equal(res.body.video, null);
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns null when no eligible media-backed featured item exists', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  const capturedFilters = [];

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilters.push(filter);
      return makeFindResult([]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=2');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.settings, { frontendEnabled: true });
    assert.equal(res.body.video, null);
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns an eligible homepage video when only a thumbnail is present', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  const capturedFilters = [];

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilters.push(filter);
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439334',
          slug: 'thumbnail-only-featured',
          title: 'Thumbnail Only Featured',
          thumbnailUrl: 'https://img.example/thumbnail-only.jpg',
          posterImage: { url: null, alt: null, publicId: null },
          videoUrl: null,
          embedUrl: null,
          uploadedVideo: { url: null, relativeUrl: null },
          language: 'gu',
          isPublished: false,
          status: 'published',
          isFeatured: false,
          isFeaturedHomepage: false,
          homepageFeatured: true,
        }),
      ]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      ok: true,
      settings: { frontendEnabled: true },
      video: {
        _id: '507f1f77bcf86cd799439334',
        title: 'Thumbnail Only Featured',
        slug: 'thumbnail-only-featured',
        thumbnailUrl: 'https://img.example/thumbnail-only.jpg',
        videoUrl: null,
        language: 'gu',
        status: 'published',
        homepageFeatured: true,
      },
    });
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns no homepage content when global viral videos visibility is off', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    SystemSetting.findOne = () => ({ lean: async () => disableViralVideosSetting() });
    ViralVideo.find = () => {
      throw new Error('featured query should not run when viral videos are disabled');
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=2');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.settings, { frontendEnabled: false });
    assert.equal(res.body.video, null);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns latest frontendEnabled value without stale cache', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  let frontendEnabled = false;
  let featuredQueries = 0;

  try {
    SystemSetting.findOne = () => ({
      lean: async () => ({ value: { frontendEnabled } }),
    });
    ViralVideo.find = () => {
      featuredQueries += 1;
      return makeFindResult([]);
    };

    const offRes = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(offRes.statusCode, 200);
    assert.equal(offRes.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
    assert.equal(offRes.headers.pragma, 'no-cache');
    assert.equal(offRes.headers.expires, '0');
    assert.deepEqual(offRes.body, {
      ok: true,
      settings: { frontendEnabled: false },
      video: null,
    });
    assert.equal(featuredQueries, 0);

    frontendEnabled = true;
    const onRes = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(onRes.statusCode, 200);
    assert.equal(onRes.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
    assert.equal(onRes.headers.pragma, 'no-cache');
    assert.equal(onRes.headers.expires, '0');
    assert.deepEqual(onRes.body, {
      ok: true,
      settings: { frontendEnabled: true },
      video: null,
    });
    assert.equal(featuredQueries, 1);

    frontendEnabled = false;
    const offAgainRes = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(offAgainRes.statusCode, 200);
    assert.deepEqual(offAgainRes.body, {
      ok: true,
      settings: { frontendEnabled: false },
      video: null,
    });
    assert.equal(featuredQueries, 1);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/:slug returns detail payload', async () => {
  const prevFindOne = ViralVideo.findOne;
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.findOne = () => makeFindOneResult(
      createVideo({
        _id: '507f1f77bcf86cd799439304',
        slug: 'viral-detail',
        title: 'Detail Viral',
        videoUrl: 'https://cdn.example/video.mp4',
        embedUrl: null,
        sourceType: 'uploaded',
        isFeatured: true,
        sortOrder: 8,
      })
    );

    const res = await request(app).get('/api/public/viral-videos/viral-detail');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.item.slug, 'viral-detail');
    assert.equal(res.body.item.videoUrl, 'https://cdn.example/video.mp4');
    assert.equal(res.body.item.embedUrl, null);
    assert.equal(res.body.item.sourceType, 'uploaded');
    assert.equal(res.body.item.isPublished, true);
    assert.equal(res.body.item.thumbnail.url, 'https://img.example/video.jpg');
    assert.equal(res.body.item.isFeaturedHomepage, true);
  } finally {
    ViralVideo.findOne = prevFindOne;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/:slug returns 404 when global viral videos visibility is off', async () => {
  const prevFindOne = ViralVideo.findOne;
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    SystemSetting.findOne = () => ({ lean: async () => disableViralVideosSetting() });
    ViralVideo.findOne = () => {
      throw new Error('detail query should not run when viral videos are disabled');
    };

    const res = await request(app).get('/api/public/viral-videos/viral-detail');

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, message: 'Viral videos are currently unavailable' });
  } finally {
    ViralVideo.findOne = prevFindOne;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/:slug/related returns related published archive items', async () => {
  const originals = { findOne: ViralVideo.findOne, find: ViralVideo.find, findOneSetting: SystemSetting.findOne };
  let findOneCalls = 0;
  let capturedRelatedFilter = null;

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.findOne = () => {
      findOneCalls += 1;
      return makeFindOneResult(
        createVideo({
          _id: '507f1f77bcf86cd799439305',
          slug: 'viral-base',
          category: 'sports',
          tags: ['cricket', 'highlight'],
          language: 'hi',
        })
      );
    };
    ViralVideo.find = (filter) => {
      capturedRelatedFilter = filter;
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439306',
          slug: 'viral-related',
          category: 'sports',
          tags: ['cricket'],
          language: 'hi',
        }),
      ]);
    };

    const res = await request(app).get('/api/public/viral-videos/viral-base/related?limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(findOneCalls, 1);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].slug, 'viral-related');
    assert.deepEqual(capturedRelatedFilter, {
      isPublished: true,
      publishedAt: { $ne: null },
      _id: { $ne: '507f1f77bcf86cd799439305' },
      $or: [
        { language: 'hi' },
        { category: 'sports' },
        { tags: { $in: ['cricket', 'highlight'] } },
      ],
    });
  } finally {
    ViralVideo.findOne = originals.findOne;
    ViralVideo.find = originals.find;
    SystemSetting.findOne = originals.findOneSetting;
  }
});

test('GET /api/viral-videos/settings returns a stable compatibility settings payload', async () => {
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    SystemSetting.findOne = () => ({ lean: async () => disableViralVideosSetting() });

    const res = await request(app).get('/api/viral-videos/settings');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      ok: true,
      enabled: false,
      data: { enabled: false },
      settings: { enabled: false },
    });
  } finally {
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/viral-videos aliases the public archive route and returns 200', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = () => makeFindResult([
      createVideo({ _id: '507f1f77bcf86cd799439377', slug: 'alias-viral-item' }),
    ]);
    ViralVideo.countDocuments = async () => 1;

    const res = await request(app).get('/api/viral-videos?publishedAt=desc');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].slug, 'alias-viral-item');
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
  }
});
