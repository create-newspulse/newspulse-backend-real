const { getSlugCandidates } = require('../lib/slug');
const ViralVideo = require('../models/ViralVideo');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_FEATURED_LIMIT = 3;
const MAX_FEATURED_LIMIT = 3;

function getBackendBaseUrl() {
  const raw = String(
    process.env.PUBLIC_BASE_URL
    || process.env.BACKEND_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || process.env.API_BASE_URL
    || ''
  ).trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || '5052'}`;
}

function absolutizeViralMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/uploads/')) return `${getBackendBaseUrl()}${raw}`;
  if (raw.startsWith('uploads/')) return `${getBackendBaseUrl()}/${raw}`;
  return raw;
}

function isUploadedVideoUrl(value) {
  const raw = String(value || '').trim().split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|webm|mov)$/.test(raw) || raw.startsWith('/uploads/') || raw.startsWith('uploads/');
}

function isYouTubeUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\//.test(raw);
}

function isXStatusUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /(^|\/\/)(www\.)?(x\.com|twitter\.com)\/(i\/status\/|[^/?#]+\/status\/)[^/?#]+/.test(raw);
}

function resolvePosterImageUrl(doc) {
  return absolutizeViralMediaUrl(doc?.thumbnailUrl || doc?.posterImageUrl || normalizePosterImage(doc?.posterImage).url);
}

function resolveVideoType(doc) {
  const explicit = String(doc?.videoType || '').trim().toLowerCase();
  const videoCandidate = doc?.videoFileUrl || doc?.videoUrl || doc?.embedUrl || doc?.sourceUrl;

  if (doc?.sourceType === 'upload' || explicit === 'uploaded' || isUploadedVideoUrl(videoCandidate)) return 'uploaded';
  if (explicit === 'youtube' || isYouTubeUrl(videoCandidate)) return 'youtube';
  if (explicit === 'x' || isXStatusUrl(videoCandidate)) return 'x';
  if (explicit === 'external') return 'external';

  if (doc?.sourceType === 'upload' || isUploadedVideoUrl(videoCandidate)) return 'uploaded';
  if (isYouTubeUrl(videoCandidate)) return 'youtube';
  if (isXStatusUrl(videoCandidate)) return 'x';
  return 'external';
}

function resolvePlaybackMode(doc, videoType) {
  const explicit = String(doc?.playbackMode || '').trim().toLowerCase();
  if (videoType === 'uploaded') return 'internal';
  if (videoType === 'youtube') return 'embed';
  if (videoType === 'x') return 'x_embed';
  if (explicit === 'internal' || explicit === 'embed' || explicit === 'x_embed' || explicit === 'external') return explicit;
  return 'external';
}

function resolveVideoFileUrl(doc, videoType) {
  if (videoType !== 'uploaded') return null;
  return absolutizeViralMediaUrl(doc?.videoFileUrl || doc?.videoUrl);
}

function resolveSourceUrl(doc, videoType) {
  if (doc?.sourceUrl) return String(doc.sourceUrl);
  if (videoType === 'external') return doc?.videoUrl || doc?.embedUrl || null;
  if (videoType === 'youtube') return doc?.videoUrl || doc?.embedUrl || null;
  if (videoType === 'x') return doc?.videoUrl || doc?.embedUrl || null;
  return null;
}

function resolvePublicVideoUrl(doc, videoType, videoFileUrl) {
  if (videoType === 'uploaded') return videoFileUrl;
  if (videoType === 'youtube') return doc?.videoUrl || doc?.embedUrl || null;
  if (videoType === 'x') return doc?.videoUrl || doc?.sourceUrl || doc?.embedUrl || null;
  return null;
}

function resolveFeaturedVideoUrl(doc) {
  return doc && doc.videoUrl ? String(doc.videoUrl) : null;
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
  const allowFallback = ['fallback', 'fallbackToBase', 'allowFallback'].some((key) => {
    const raw = String(query[key] ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y';
  });

  return { page, limit, lang, category, year, month, tag, allowFallback };
}

function buildActiveFilterClause() {
  return { $or: [{ isActive: true }, { isActive: { $exists: false } }] };
}

function buildGlobalFrontendFilterClause() {
  return { $or: [{ globalFrontend: true }, { globalFrontend: { $exists: false } }] };
}

function buildPublishedFilter(filters = {}) {
  const filter = {
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
      {
        $or: [
          { isPublished: true },
          { status: 'published' },
        ],
      },
    ],
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

function buildFeaturedHomepageFilter(filters = {}) {
  const filter = {
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
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
  const url = image && typeof image === 'object' ? image.url : null;

  if (!image || typeof image !== 'object') {
    return { url: null, alt: null, publicId: null };
  }

  return {
    url: absolutizeViralMediaUrl(url),
    alt: image.alt ? String(image.alt) : null,
    publicId: image.publicId ? String(image.publicId) : null,
  };
}

function normalizeSourceType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'upload' || raw === 'uploaded') return 'upload';
  return 'url';
}

function toPublicViralVideoCard(doc) {
  if (!doc) return null;
  const videoType = resolveVideoType(doc);
  const playbackMode = resolvePlaybackMode(doc, videoType);
  const posterImageUrl = resolvePosterImageUrl(doc);
  const posterImage = normalizePosterImage({ ...(doc.posterImage || {}), url: posterImageUrl });
  const videoFileUrl = resolveVideoFileUrl(doc, videoType);
  const sourceUrl = resolveSourceUrl(doc, videoType);

  return {
    id: String(doc._id),
    title: doc.title || null,
    slug: doc.slug || null,
    shortCaption: doc.summary || null,
    summary: doc.summary || null,
    thumbnailUrl: posterImageUrl,
    posterImageUrl,
    posterImage,
    thumbnail: posterImage,
    sourceName: doc.sourceName || null,
    sourceUrl,
    videoType,
    playbackMode,
    sourceType: normalizeSourceType(doc.sourceType),
    videoStorageProvider: doc.videoStorageProvider || null,
    videoPublicId: doc.videoPublicId || null,
    videoKey: doc.videoKey || null,
    videoMimeType: doc.videoMimeType || null,
    videoSizeBytes: typeof doc.videoSizeBytes === 'number' ? doc.videoSizeBytes : null,
    videoDuration: typeof doc.videoDuration === 'number' ? doc.videoDuration : null,
    language: doc.language || null,
    category: doc.category || null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    isHomepageVisible: doc.isHomepageVisible === true,
    showOnHomepage: doc.isHomepageVisible === true,
    isActive: doc.isActive !== false,
    globalFrontend: doc.globalFrontend !== false,
    homepageFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    isFeaturedHomepage: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    isFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
    status: doc.status || (doc.isPublished === true ? 'published' : 'draft'),
    videoUrl: resolvePublicVideoUrl(doc, videoType, videoFileUrl),
    videoFileUrl,
    publishedAt: doc.publishedAt || null,
    updatedAt: doc.updatedAt || null,
    sortOrder: typeof doc.sortOrder === 'number' ? doc.sortOrder : 0,
    priority: typeof doc.sortOrder === 'number' ? doc.sortOrder : 0,
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
  const homepageFlag = doc.isHomepageVisible === true || doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true;
  const videoType = resolveVideoType(doc);
  const playbackMode = resolvePlaybackMode(doc, videoType);
  const posterImageUrl = resolvePosterImageUrl(doc);
  const videoFileUrl = resolveVideoFileUrl(doc, videoType);
  const sourceUrl = resolveSourceUrl(doc, videoType);

  return {
    id: String(doc._id),
    _id: String(doc._id),
    title: doc.title || null,
    slug: doc.slug || null,
    summary: doc.summary || null,
    thumbnailUrl: posterImageUrl || resolveFeaturedThumbnailUrl(doc),
    posterImageUrl: posterImageUrl || resolveFeaturedThumbnailUrl(doc),
    videoUrl: resolvePublicVideoUrl(doc, videoType, videoFileUrl),
    videoFileUrl,
    sourceUrl,
    sourceName: doc.sourceName || null,
    videoType,
    playbackMode,
    language: doc.language || null,
    category: doc.category || null,
    status: doc.status || (doc.isPublished === true ? 'published' : 'draft'),
    isActive: doc.isActive !== false,
    globalFrontend: doc.globalFrontend !== false,
    showOnHomepage: homepageFlag,
    publishedAt: doc.publishedAt || null,
    updatedAt: doc.updatedAt || null,
    sortOrder: typeof doc.sortOrder === 'number' ? doc.sortOrder : 0,
    priority: typeof doc.sortOrder === 'number' ? doc.sortOrder : 0,
    homepageFeatured: doc.homepageFeatured === true || doc.isFeatured === true || doc.isFeaturedHomepage === true,
  };
}

function toPublicViralVideoDetail(doc) {
  const base = toPublicViralVideoCard(doc);
  if (!base) return null;

  return {
    ...base,
    videoUrl: base.videoUrl,
    videoFileUrl: base.videoFileUrl,
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

  let [items, total] = await Promise.all([
    ViralVideo.find(filter).sort(buildListSort()).skip(skip).limit(filters.limit).lean(),
    ViralVideo.countDocuments(filter),
  ]);

  let usedLanguageFallback = false;
  if (filters.lang && filters.allowFallback && total === 0) {
    const fallbackFilters = { ...filters, lang: null };
    const fallbackFilter = buildPublishedFilter(fallbackFilters);
    const fallbackItems = await ViralVideo.find(fallbackFilter).sort(buildListSort()).limit(filters.limit).lean();
    items = fallbackItems || [];
    total = items.length;
    usedLanguageFallback = items.length > 0;
  }

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
    usedLanguageFallback,
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
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
      { isPublished: true },
    ],
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
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
      { isPublished: true },
    ],
    publishedAt: { $ne: null },
    slug: candidates.length === 1 ? candidates[0] : { $in: candidates },
  }).lean();
  if (!baseDoc) return null;

  const limit = parsePositiveInt(rawQuery.limit, 6, { min: 1, max: 12 });
  const relatedFilter = {
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
      { isPublished: true },
    ],
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
  buildActiveFilterClause,
  buildGlobalFrontendFilterClause,
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
