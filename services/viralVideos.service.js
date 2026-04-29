const { getSlugCandidates } = require('../lib/slug');
const ViralVideo = require('../models/ViralVideo');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_FEATURED_LIMIT = 3;
const MAX_FEATURED_LIMIT = 6;

function resolveUploadedVideo(doc) {
  const uploaded = doc && doc.uploadedVideo && typeof doc.uploadedVideo === 'object' ? doc.uploadedVideo : null;
  if (!uploaded) {
    return {
      storageId: null,
      fileName: null,
      originalName: null,
      mimeType: null,
      provider: null,
      relativeUrl: null,
      url: null,
      size: 0,
    };
  }

  return {
    storageId: uploaded.storageId ? String(uploaded.storageId) : null,
    fileName: uploaded.fileName ? String(uploaded.fileName) : null,
    originalName: uploaded.originalName ? String(uploaded.originalName) : null,
    mimeType: uploaded.mimeType ? String(uploaded.mimeType) : null,
    provider: uploaded.provider ? String(uploaded.provider) : null,
    relativeUrl: uploaded.relativeUrl ? String(uploaded.relativeUrl) : null,
    url: uploaded.url ? String(uploaded.url) : null,
    size: typeof uploaded.size === 'number' ? uploaded.size : 0,
  };
}

function resolvePlaybackVideoUrl(doc) {
  const uploaded = resolveUploadedVideo(doc);
  return uploaded.url || uploaded.relativeUrl || doc.videoUrl || null;
}

function resolveFeaturedVideoUrl(doc) {
  return resolvePlaybackVideoUrl(doc) || doc.embedUrl || null;
}

function resolveFeaturedThumbnailUrl(doc) {
  if (doc && doc.thumbnailUrl) return String(doc.thumbnailUrl);
  if (doc && doc.thumbnail && typeof doc.thumbnail === 'object' && doc.thumbnail.url) return String(doc.thumbnail.url);
  return normalizePosterImage(doc && doc.posterImage).url;
}

function normalizeLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  return primary === 'en' || primary === 'hi' || primary === 'gu' ? primary : null;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseArchiveFilters(query = {}) {
  const page = parsePositiveInt(query.page, 1, { min: 1, max: 100000 });
  const limit = parsePositiveInt(query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  const lang = normalizeLang(query.lang || query.language);
  const category = String(query.category || '').trim() || null;
  const year = parsePositiveInt(query.year, null, { min: 2000, max: 9999 });
  const month = parsePositiveInt(query.month, null, { min: 1, max: 12 });
  const tag = String(query.tag || '').trim() || null;

  return { page, limit, lang, category, year, month, tag };
}

function buildPublishedFilter(filters = {}) {
  const filter = {
    isPublished: true,
    publishedAt: { $ne: null },
  };

  if (filters.lang) filter.language = filters.lang;
  if (filters.category) filter.category = filters.category;
  if (filters.tag) filter.tags = filters.tag;

  if (filters.year || filters.month) {
    const startYear = filters.year || new Date().getUTCFullYear();
    const startMonthIndex = filters.month ? (filters.month - 1) : 0;
    const endMonthIndex = filters.month ? filters.month : 12;

    filter.publishedAt = {
      $gte: new Date(Date.UTC(startYear, startMonthIndex, 1, 0, 0, 0, 0)),
      $lt: new Date(Date.UTC(startYear + (filters.month ? 0 : 1), endMonthIndex, 1, 0, 0, 0, 0)),
    };
  }

  return filter;
}

function buildHomepageVisibilityFilter(filters = {}) {
  return {
    ...buildPublishedFilter(filters),
    isHomepageVisible: true,
  };
}

function nonEmptyStringQuery() {
  return { $type: 'string', $ne: '' };
}

function buildFeaturedHomepageFilter(filters = {}) {
  const filter = {
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
          { thumbnailUrl: nonEmptyStringQuery() },
          { 'posterImage.url': nonEmptyStringQuery() },
          { 'thumbnail.url': nonEmptyStringQuery() },
          { videoUrl: nonEmptyStringQuery() },
          { 'uploadedVideo.url': nonEmptyStringQuery() },
          { 'uploadedVideo.relativeUrl': nonEmptyStringQuery() },
          { embedUrl: nonEmptyStringQuery() },
        ],
      },
    ],
  };

  if (filters.year || filters.month) {
    filter.publishedAt = buildPublishedFilter(filters).publishedAt;
  }
  if (filters.lang) filter.language = filters.lang;
  if (filters.category) filter.category = filters.category;
  if (filters.tag) filter.tags = filters.tag;

  return filter;
}

function buildListSort() {
  return { publishedAt: -1, sortOrder: -1, createdAt: -1 };
}

function normalizePosterImage(image) {
  if (!image || typeof image !== 'object') {
    return { url: null, alt: null, publicId: null };
  }

  return {
    url: image.url ? String(image.url) : null,
    alt: image.alt ? String(image.alt) : null,
    publicId: image.publicId ? String(image.publicId) : null,
  };
}

function toPublicViralVideoCard(doc) {
  if (!doc) return null;

  return {
    id: String(doc._id),
    title: doc.title || null,
    slug: doc.slug || null,
    shortCaption: doc.summary || null,
    summary: doc.summary || null,
    thumbnailUrl: doc.thumbnailUrl || normalizePosterImage(doc.posterImage).url,
    posterImage: normalizePosterImage(doc.posterImage),
    thumbnail: normalizePosterImage(doc.posterImage),
    sourceType: doc.sourceType || null,
    language: doc.language || null,
    category: doc.category || null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    isHomepageVisible: doc.isHomepageVisible === true,
    homepageFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    isFeaturedHomepage: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    isFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    status: doc.status || (doc.isPublished === true ? 'published' : 'draft'),
    publishedAt: doc.publishedAt || null,
    sortOrder: typeof doc.sortOrder === 'number' ? doc.sortOrder : 0,
  };
}

function toPublicViralVideoTeaser(doc) {
  const base = toPublicViralVideoCard(doc);
  if (!base) return null;

  return {
    ...base,
    path: base.slug ? `/viral-videos/${base.slug}` : null,
  };
}

function toPublicFeaturedViralVideo(doc) {
  if (!doc) return null;

  return {
    _id: String(doc._id),
    title: doc.title || null,
    slug: doc.slug || null,
    thumbnailUrl: resolveFeaturedThumbnailUrl(doc),
    videoUrl: resolveFeaturedVideoUrl(doc),
    language: doc.language || null,
    status: doc.status || (doc.isPublished === true ? 'published' : 'draft'),
    homepageFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
  };
}

function toPublicViralVideoDetail(doc) {
  const base = toPublicViralVideoCard(doc);
  if (!base) return null;

  return {
    ...base,
    uploadedVideo: resolveUploadedVideo(doc),
    videoUrl: resolvePlaybackVideoUrl(doc),
    embedUrl: doc.embedUrl || null,
    isPublished: doc.isPublished === true,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listPublishedViralVideos(rawQuery = {}) {
  const filters = parseArchiveFilters(rawQuery);
  const filter = buildPublishedFilter(filters);
  const skip = (filters.page - 1) * filters.limit;

  const [items, total] = await Promise.all([
    ViralVideo.find(filter).sort(buildListSort()).skip(skip).limit(filters.limit).lean(),
    ViralVideo.countDocuments(filter),
  ]);

  return {
    items: (items || []).map(toPublicViralVideoCard),
    page: filters.page,
    limit: filters.limit,
    total,
    totalPages: Math.max(Math.ceil(total / filters.limit), 1),
    filters: {
      lang: filters.lang,
      category: filters.category,
      year: filters.year,
      month: filters.month,
      tag: filters.tag,
    },
  };
}

async function listFeaturedViralVideos(rawQuery = {}) {
  const filters = parseArchiveFilters(rawQuery);
  const limit = parsePositiveInt(rawQuery.limit, DEFAULT_FEATURED_LIMIT, { min: 1, max: MAX_FEATURED_LIMIT });
  const featuredFilter = buildFeaturedHomepageFilter(filters);

  const items = await ViralVideo.find(featuredFilter).sort(buildListSort()).limit(limit).lean();

  return (items || []).map(toPublicFeaturedViralVideo);
}

async function getPublishedViralVideoBySlug(slug) {
  const candidates = getSlugCandidates(slug);
  if (!candidates.length) return null;

  const filter = {
    isPublished: true,
    publishedAt: { $ne: null },
    slug: candidates.length === 1 ? candidates[0] : { $in: candidates },
  };

  const doc = await ViralVideo.findOne(filter).lean();
  return toPublicViralVideoDetail(doc);
}

async function listRelatedPublishedViralVideos(slug, rawQuery = {}) {
  const candidates = getSlugCandidates(slug);
  if (!candidates.length) return [];

  const baseDoc = await ViralVideo.findOne({
    isPublished: true,
    publishedAt: { $ne: null },
    slug: candidates.length === 1 ? candidates[0] : { $in: candidates },
  }).lean();
  if (!baseDoc) return null;

  const limit = parsePositiveInt(rawQuery.limit, 6, { min: 1, max: 12 });
  const relatedFilter = {
    isPublished: true,
    publishedAt: { $ne: null },
    _id: { $ne: baseDoc._id },
  };

  const orClauses = [];
  if (baseDoc.language) orClauses.push({ language: baseDoc.language });
  if (baseDoc.category) orClauses.push({ category: baseDoc.category });
  if (Array.isArray(baseDoc.tags) && baseDoc.tags.length) orClauses.push({ tags: { $in: baseDoc.tags } });
  if (orClauses.length) relatedFilter.$or = orClauses;

  const items = await ViralVideo.find(relatedFilter).sort(buildListSort()).limit(limit).lean();
  return (items || []).map(toPublicViralVideoCard);
}

module.exports = {
  buildPublishedFilter,
  buildHomepageVisibilityFilter,
  buildFeaturedHomepageFilter,
  listPublishedViralVideos,
  listFeaturedViralVideos,
  getPublishedViralVideoBySlug,
  listRelatedPublishedViralVideos,
  toPublicViralVideoCard,
  toPublicViralVideoDetail,
  toPublicViralVideoTeaser,
  toPublicFeaturedViralVideo,
  parseArchiveFilters,
  normalizeLang,
};
