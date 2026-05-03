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
      viralVideosFrontendEnabled: true,
      frontendEnabled: true,
    },
  };
}

function disableViralVideosSetting() {
  return {
    value: {
      viralVideosFrontendEnabled: false,
      frontendEnabled: false,
    },
  };
}

function expectedFeaturedSettings(enabled) {
  return { frontendEnabled: enabled, viralVideosFrontendEnabled: enabled };
}

function expectedActiveClause() {
  return { $or: [{ isActive: true }, { isActive: { $exists: false } }] };
}

function expectedGlobalFrontendClause() {
  return { $or: [{ globalFrontend: true }, { globalFrontend: { $exists: false } }] };
}

function expectedPublishedArchiveBaseFilter() {
  return {
    $and: [
      expectedActiveClause(),
      expectedGlobalFrontendClause(),
      {
        $or: [
          { isPublished: true },
          { status: 'published' },
        ],
      },
    ],
    publishedAt: { $ne: null },
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
    sourceType: overrides.sourceType || 'url',
    language: overrides.language || 'en',
    category: overrides.category || 'funny',
    tags: overrides.tags || ['cats'],
    sourceName: overrides.sourceName || 'News Pulse',
    sourceUrl: overrides.sourceUrl !== undefined ? overrides.sourceUrl : null,
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    globalFrontend: overrides.globalFrontend !== undefined ? overrides.globalFrontend : true,
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
    posterImageUrl: overrides.posterImageUrl,
    videoFileUrl: overrides.videoFileUrl,
    videoType: overrides.videoType,
    playbackMode: overrides.playbackMode,
  };
}

function expectedFeaturedHomepageFilter() {
  return {
    $and: [
      expectedActiveClause(),
      expectedGlobalFrontendClause(),
      {
        status: 'published',
      },
      {
        $or: [
          { isHomepageVisible: true },
          { homepageFeatured: true },
          { isFeatured: true },
          { isFeaturedHomepage: true },
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
    assert.equal(res.body.items[0].isActive, true);
    assert.equal(res.body.items[0].sourceName, 'News Pulse');
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.totalPages, 1);
    assert.deepEqual(res.body.filters, { lang: 'en', category: 'funny', year: null, month: null, tag: 'cats' });
    assert.deepEqual(capturedFilter, {
      ...expectedPublishedArchiveBaseFilter(),
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

test('GET /api/public/viral-videos returns Gujarati active published card with thumbnail', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };
  let capturedFilter = null;

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilter = filter;
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439388',
          slug: 'gujarati-short-card',
          title: 'Gujarati short card',
          language: 'gu',
          sourceName: 'Divya Bhaskar',
          thumbnailUrl: 'https://img.example/gujarati-short.jpg',
          posterImage: { url: 'https://img.example/gujarati-short.jpg', alt: 'Gujarati short card', publicId: null },
          videoUrl: 'https://cdn.example/gujarati-short.mp4',
          status: 'published',
          isActive: true,
        }),
      ]);
    };
    ViralVideo.countDocuments = async (filter) => {
      capturedFilter = filter;
      return 1;
    };

    const res = await request(app).get('/api/public/viral-videos?lang=gu&limit=6');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].language, 'gu');
    assert.equal(res.body.items[0].sourceName, 'Divya Bhaskar');
    assert.equal(res.body.items[0].status, 'published');
    assert.equal(res.body.items[0].isActive, true);
    assert.equal(res.body.items[0].thumbnailUrl, 'https://img.example/gujarati-short.jpg');
    assert.equal(res.body.items[0].posterImageUrl, 'https://img.example/gujarati-short.jpg');
    assert.equal(res.body.items[0].posterImage.url, 'https://img.example/gujarati-short.jpg');
    assert.equal(res.body.items[0].videoUrl, 'https://cdn.example/gujarati-short.mp4');
    assert.equal(res.body.items[0].videoFileUrl, 'https://cdn.example/gujarati-short.mp4');
    assert.equal(res.body.items[0].videoType, 'uploaded');
    assert.equal(res.body.items[0].playbackMode, 'internal');
    assert.deepEqual(capturedFilter, {
      ...expectedPublishedArchiveBaseFilter(),
      language: 'gu',
    });
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
  }
});

test('GET /api/public/viral-videos returns absolute uploaded thumbnail and poster image URLs', async (t) => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne, publicBaseUrl: process.env.PUBLIC_BASE_URL };
  let capturedFilter = null;

  try {
    process.env.PUBLIC_BASE_URL = 'https://api.newspulse.test';
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = (filter) => {
      capturedFilter = filter;
      return makeFindResult([
        createVideo({
          _id: '507f1f77bcf86cd799439389',
          slug: 'uploaded-thumbnail-card',
          thumbnailUrl: '/uploads/viral-thumb.jpg',
          posterImageUrl: '/uploads/viral-thumb.jpg',
          posterImage: { url: '/uploads/viral-thumb.jpg', alt: 'Uploaded poster', publicId: null },
          videoUrl: '/uploads/viral-clip.mp4',
          status: 'published',
          isActive: true,
          globalFrontend: true,
        }),
      ]);
    };
    ViralVideo.countDocuments = async (filter) => {
      capturedFilter = filter;
      return 1;
    };

    const res = await request(app).get('/api/public/viral-videos?lang=en&limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].thumbnailUrl, 'https://api.newspulse.test/uploads/viral-thumb.jpg');
    assert.equal(res.body.items[0].posterImageUrl, 'https://api.newspulse.test/uploads/viral-thumb.jpg');
    assert.equal(res.body.items[0].posterImage.url, 'https://api.newspulse.test/uploads/viral-thumb.jpg');
    assert.equal(res.body.items[0].videoFileUrl, 'https://api.newspulse.test/uploads/viral-clip.mp4');
    assert.equal(res.body.items[0].videoUrl, 'https://api.newspulse.test/uploads/viral-clip.mp4');
    assert.equal(res.body.items[0].videoType, 'uploaded');
    assert.equal(res.body.items[0].playbackMode, 'internal');
    assert.deepEqual(capturedFilter, {
      ...expectedPublishedArchiveBaseFilter(),
      language: 'en',
    });
  } finally {
    ViralVideo.find = originals.find;
    ViralVideo.countDocuments = originals.countDocuments;
    SystemSetting.findOne = originals.findOneSetting;
    if (originals.publicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = originals.publicBaseUrl;
  }
});

test('GET /api/public/viral-videos returns external source pages as non-playable links', async () => {
  const originals = { find: ViralVideo.find, countDocuments: ViralVideo.countDocuments, findOneSetting: SystemSetting.findOne };

  try {
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.find = () => makeFindResult([
      createVideo({
        _id: '507f1f77bcf86cd799439390',
        slug: 'external-source-card',
        videoUrl: 'https://www.instagram.com/reel/demo/',
        sourceUrl: 'https://www.instagram.com/reel/demo/',
        embedUrl: null,
        status: 'published',
        isActive: true,
      }),
    ]);
    ViralVideo.countDocuments = async () => 1;

    const res = await request(app).get('/api/public/viral-videos?limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items[0].videoType, 'external');
    assert.equal(res.body.items[0].playbackMode, 'external');
    assert.equal(res.body.items[0].sourceUrl, 'https://www.instagram.com/reel/demo/');
    assert.equal(res.body.items[0].videoUrl, null);
    assert.equal(res.body.items[0].videoFileUrl, null);
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
          category: 'news',
          isPublished: false,
          status: 'published',
          isHomepageVisible: false,
          isFeatured: false,
          isFeaturedHomepage: false,
          homepageFeatured: true,
        }),
      ]);
    };

    const res = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(true));
    assert.equal(res.body.video.slug, 'homepage-featured-fields');
    assert.equal(res.body.video.id, '507f1f77bcf86cd799439333');
    assert.equal(res.body.video.title, 'Homepage Featured Fields');
    assert.equal(res.body.video.summary, 'Short summary');
    assert.equal(res.body.video.language, 'gu');
    assert.equal(res.body.video.category, 'news');
    assert.equal(res.body.video.thumbnailUrl, 'https://img.example/homepage-featured.jpg');
    assert.equal(res.body.video.videoUrl, 'https://cdn.example/homepage-featured.mp4');
    assert.equal(res.body.video.status, 'published');
    assert.equal(res.body.video.showOnHomepage, true);
    assert.ok(res.body.video.publishedAt);
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(res.body.videos, res.body.items);
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
    assert.equal(res.body.viralVideosFrontendEnabled, false);
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
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(true));
    assert.equal(res.body.video.slug, 'featured-viral');
    assert.equal(res.body.video.thumbnailUrl, 'https://img.example/video.jpg');
    assert.equal(res.body.video.videoUrl, 'https://cdn.example/featured-viral.mp4');
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(res.body.videos, res.body.items);
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
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(true));
    assert.equal(res.body.video, null);
    assert.deepEqual(res.body.items, []);
    assert.deepEqual(res.body.videos, []);
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns enabled true with empty items when no homepage item exists', async () => {
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
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(true));
    assert.equal(res.body.video, null);
    assert.deepEqual(res.body.items, []);
    assert.deepEqual(res.body.videos, []);
    assert.deepEqual(capturedFilters, [expectedFeaturedHomepageFilter()]);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns an eligible homepage video when thumbnail and videoUrl are present', async () => {
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
          videoUrl: 'https://cdn.example/thumbnail-plus-url.mp4',
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
    assert.equal(res.body.ok, true);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(true));
    assert.equal(res.body.video.slug, 'thumbnail-only-featured');
    assert.equal(res.body.video.thumbnailUrl, 'https://img.example/thumbnail-only.jpg');
    assert.equal(res.body.video.videoUrl, 'https://cdn.example/thumbnail-plus-url.mp4');
    assert.equal(res.body.items.length, 1);
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
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.settings, expectedFeaturedSettings(false));
    assert.equal(res.body.video, null);
    assert.deepEqual(res.body.items, []);
  } finally {
    ViralVideo.find = prevFind;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/featured returns latest viralVideosFrontendEnabled value without stale cache', async () => {
  const prevFind = ViralVideo.find;
  const prevFindOneSetting = SystemSetting.findOne;
  let viralVideosFrontendEnabled = false;
  let featuredQueries = 0;

  try {
    SystemSetting.findOne = () => ({
      lean: async () => ({ value: { viralVideosFrontendEnabled } }),
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
      enabled: false,
      settings: expectedFeaturedSettings(false),
      video: null,
      items: [],
      videos: [],
    });
    assert.equal(featuredQueries, 0);

    viralVideosFrontendEnabled = true;
    const onRes = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(onRes.statusCode, 200);
    assert.equal(onRes.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
    assert.equal(onRes.headers.pragma, 'no-cache');
    assert.equal(onRes.headers.expires, '0');
    assert.deepEqual(onRes.body, {
      ok: true,
      enabled: true,
      settings: expectedFeaturedSettings(true),
      video: null,
      items: [],
      videos: [],
    });
    assert.equal(featuredQueries, 1);

    viralVideosFrontendEnabled = false;
    const offAgainRes = await request(app).get('/api/public/viral-videos/featured?limit=1');

    assert.equal(offAgainRes.statusCode, 200);
    assert.deepEqual(offAgainRes.body, {
      ok: true,
      enabled: false,
      settings: expectedFeaturedSettings(false),
      video: null,
      items: [],
      videos: [],
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
        sourceType: 'upload',
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
    assert.equal(res.body.item.sourceType, 'upload');
    assert.equal(res.body.item.isPublished, true);
    assert.equal(res.body.item.thumbnail.url, 'https://img.example/video.jpg');
    assert.equal(res.body.item.isFeaturedHomepage, true);
  } finally {
    ViralVideo.findOne = prevFindOne;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/:slug returns X status embed contract', async () => {
  const prevFindOne = ViralVideo.findOne;
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    const xUrl = 'https://x.com/i/status/2050104453630718079';
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.findOne = () => makeFindOneResult(
      createVideo({
        _id: '507f1f77bcf86cd799439391',
        slug: 'x-status-detail',
        title: 'X Status Detail',
        sourceName: 'X',
        sourceUrl: xUrl,
        videoUrl: xUrl,
        embedUrl: null,
        videoType: 'x',
        playbackMode: 'x_embed',
        thumbnailUrl: 'https://img.example/x-status.jpg',
        posterImageUrl: 'https://img.example/x-status.jpg',
        posterImage: { url: 'https://img.example/x-status.jpg', alt: 'X status', publicId: null },
        status: 'published',
        isActive: true,
      })
    );

    const res = await request(app).get('/api/public/viral-videos/x-status-detail');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.item.slug, 'x-status-detail');
    assert.equal(res.body.item.videoType, 'x');
    assert.equal(res.body.item.playbackMode, 'x_embed');
    assert.equal(res.body.item.videoUrl, xUrl);
    assert.equal(res.body.item.sourceUrl, xUrl);
    assert.equal(res.body.item.sourceName, 'X');
    assert.equal(res.body.item.videoFileUrl, null);
    assert.equal(res.body.item.thumbnailUrl, 'https://img.example/x-status.jpg');
    assert.equal(res.body.item.posterImageUrl, 'https://img.example/x-status.jpg');
  } finally {
    ViralVideo.findOne = prevFindOne;
    SystemSetting.findOne = prevFindOneSetting;
  }
});

test('GET /api/public/viral-videos/:slug upgrades saved external X status metadata', async () => {
  const prevFindOne = ViralVideo.findOne;
  const prevFindOneSetting = SystemSetting.findOne;

  try {
    const xUrl = 'https://x.com/i/status/2050104453630718079';
    SystemSetting.findOne = () => ({ lean: async () => enableViralVideosSetting() });
    ViralVideo.findOne = () => makeFindOneResult(
      createVideo({
        _id: '507f1f77bcf86cd799439392',
        slug: 'saved-external-x-status',
        title: 'Saved External X Status',
        sourceName: 'News source',
        sourceUrl: xUrl,
        videoUrl: xUrl,
        embedUrl: null,
        videoType: 'external',
        playbackMode: 'external',
        videoFileUrl: null,
        thumbnailUrl: 'https://img.example/saved-x-status.jpg',
        posterImageUrl: 'https://img.example/saved-x-status.jpg',
        posterImage: { url: 'https://img.example/saved-x-status.jpg', alt: 'Saved X status', publicId: null },
        status: 'published',
        isActive: true,
      })
    );

    const res = await request(app).get('/api/public/viral-videos/saved-external-x-status');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.item.videoType, 'x');
    assert.equal(res.body.item.playbackMode, 'x_embed');
    assert.equal(res.body.item.videoUrl, xUrl);
    assert.equal(res.body.item.sourceUrl, xUrl);
    assert.equal(res.body.item.videoFileUrl, null);
    assert.equal(res.body.item.thumbnailUrl, 'https://img.example/saved-x-status.jpg');
    assert.equal(res.body.item.posterImageUrl, 'https://img.example/saved-x-status.jpg');
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
      $and: [
        expectedActiveClause(),
        expectedGlobalFrontendClause(),
        { isPublished: true },
      ],
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
      viralVideosFrontendEnabled: false,
      data: { enabled: false, viralVideosFrontendEnabled: false },
      settings: { enabled: false, viralVideosFrontendEnabled: false },
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
