const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { getSlugCandidates, slugifyUnicode } = require('../lib/slug');
const ViralVideo = require('../models/ViralVideo');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_FEATURED_LIMIT = 3;
const MAX_FEATURED_LIMIT = 3;
const VIRAL_VIDEO_DATA_FILE = path.join(process.cwd(), 'data', 'viral-videos.json');
const IST_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIRAL_VIDEO_DAILY_PUBLISH_LIMIT = 15;

function getIstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function formatUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function getIstDateRange(dateString) {
  const raw = String(dateString || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split('-').map(Number);
  const startMs = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  return {
    date: raw,
    timezone: IST_TIMEZONE,
    start: new Date(startMs),
    end: new Date(startMs + DAY_MS),
  };
}

function getIstTodayDateString(now = new Date()) {
  return getIstDateParts(now).date;
}

function getIstYesterdayDateString(now = new Date()) {
  const todayRange = getIstDateRange(getIstTodayDateString(now));
  return formatUtcDateString(new Date(todayRange.start.getTime() + IST_OFFSET_MS - DAY_MS));
}

function getIstThisWeekRange(now = new Date()) {
  const today = getIstDateParts(now);
  const localUtcMidnight = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const dayOfWeek = localUtcMidnight.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const mondayLocalDate = new Date(localUtcMidnight.getTime() - (daysSinceMonday * DAY_MS));
  const startDate = formatUtcDateString(mondayLocalDate);
  const startRange = getIstDateRange(startDate);
  return {
    date: startDate,
    timezone: IST_TIMEZONE,
    start: startRange.start,
    end: new Date(startRange.start.getTime() + (7 * DAY_MS)),
  };
}

function getPublishedAtRangeFromQuery(query = {}, now = new Date()) {
  const date = String(query.date || '').trim().toLowerCase();
  const period = String(query.period || '').trim().toLowerCase();

  if (period === 'all') return null;
  if (period === 'this-week' || period === 'this_week') return getIstThisWeekRange(now);

  if (date === 'today') return getIstDateRange(getIstTodayDateString(now));
  if (date === 'yesterday') return getIstDateRange(getIstYesterdayDateString(now));
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return getIstDateRange(date);

  return null;
}

function toDateOrNull(value) {
  const date = value instanceof Date ? value : (value ? new Date(value) : null);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'published' || raw === 'unpublished' || raw === 'archived') return raw;
  if (raw === 'scheduled') return 'draft';
  return 'draft';
}

function normalizeRequiredViralCategory(value) {
  return String(value || '').trim().toLowerCase() === 'viral' ? 'viral' : '__no_matching_viral_category__';
}

function normalizeFileVideoRecord(record = {}) {
  const id = String(record._id || record.id || crypto.randomUUID());
  const createdAt = toDateOrNull(record.createdAt) || new Date();
  const updatedAt = toDateOrNull(record.updatedAt) || createdAt;
  const status = normalizeStatus(record.status || (record.isPublished === true ? 'published' : 'draft'));
  const description = String(record.description || record.summary || '').trim() || null;
  const summary = String(record.summary || record.description || '').trim() || null;
  const source = String(record.source || record.sourceName || 'News Pulse').trim() || 'News Pulse';
  const thumbnailUrl = String(record.thumbnailUrl || record.posterImageUrl || record.posterImage?.url || '').trim() || null;
  const videoUrl = String(record.videoUrl || record.videoFileUrl || record.embedUrl || record.sourceUrl || '').trim() || null;

  return {
    ...record,
    id,
    _id: id,
    title: String(record.title || '').trim(),
    description,
    summary,
    slug: String(record.slug || '').trim().toLowerCase(),
    thumbnailUrl,
    posterImageUrl: String(record.posterImageUrl || thumbnailUrl || '').trim() || null,
    posterImage: record.posterImage && typeof record.posterImage === 'object'
      ? record.posterImage
      : { url: thumbnailUrl, publicId: null, alt: null },
    videoUrl,
    videoFileUrl: String(record.videoFileUrl || '').trim() || null,
    embedUrl: String(record.embedUrl || '').trim() || null,
    duration: String(record.duration || '').trim() || null,
    language: normalizeLang(record.language) || 'en',
    category: 'viral',
    status,
    isPublished: status === 'published',
    isActive: record.isActive !== false,
    globalFrontend: record.globalFrontend !== false,
    isHomepageVisible: record.isHomepageVisible === true || record.showOnHomepage === true,
    showOnHomepage: record.isHomepageVisible === true || record.showOnHomepage === true,
    isFeatured: record.isFeatured === true || record.featured === true,
    featured: record.isFeatured === true || record.featured === true,
    scheduledAt: toDateOrNull(record.scheduledAt) ? toDateOrNull(record.scheduledAt).toISOString() : null,
    source,
    sourceName: String(record.sourceName || source).trim() || source,
    uploadedBy: String(record.uploadedBy || '').trim() || null,
    publishedAt: status === 'published' ? (toDateOrNull(record.publishedAt) || createdAt).toISOString() : null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

async function readViralVideoFileRecords() {
  try {
    const raw = await fs.readFile(VIRAL_VIDEO_DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.videos) ? parsed.videos : []);
    return rows.map(normalizeFileVideoRecord).filter((item) => item.title && item.videoUrl);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeViralVideoFileRecords(records) {
  const rows = Array.isArray(records) ? records.map(normalizeFileVideoRecord) : [];
  await fs.mkdir(path.dirname(VIRAL_VIDEO_DATA_FILE), { recursive: true });
  await fs.writeFile(VIRAL_VIDEO_DATA_FILE, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  return rows;
}

function buildFileListSort(left, right) {
  const leftTime = (toDateOrNull(left.publishedAt) || toDateOrNull(left.createdAt) || new Date(0)).getTime();
  const rightTime = (toDateOrNull(right.publishedAt) || toDateOrNull(right.createdAt) || new Date(0)).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftSort = typeof left.sortOrder === 'number' ? left.sortOrder : 0;
  const rightSort = typeof right.sortOrder === 'number' ? right.sortOrder : 0;
  return rightSort - leftSort;
}

function isPublishedViralVideoRecord(record, filters = {}) {
  if (!record || record.status !== 'published' || record.category !== 'viral') return false;
  if (record.isActive === false || record.globalFrontend === false) return false;
  if (filters.lang && record.language !== filters.lang) return false;
  if (filters.category && filters.category !== 'viral') return false;
  if (filters.tag && !((Array.isArray(record.tags) ? record.tags : []).includes(filters.tag))) return false;
  if (filters.publishedAtRange) {
    const publishedAt = toDateOrNull(record.publishedAt);
    if (!publishedAt || publishedAt < filters.publishedAtRange.start || publishedAt >= filters.publishedAtRange.end) return false;
  }
  return true;
}

async function listPublishedViralVideosFromFile(rawQuery = {}) {
  const filters = parseArchiveFilters(rawQuery);
  const all = await readViralVideoFileRecords();
  const filtered = all.filter((item) => isPublishedViralVideoRecord(item, filters)).sort(buildFileListSort);
  const start = (filters.page - 1) * filters.limit;
  const items = filtered.slice(start, start + filters.limit);

  return {
    items: items.map(toPublicViralVideoCard),
    page: filters.page,
    limit: filters.limit,
    total: filtered.length,
    totalPages: Math.max(Math.ceil(filtered.length / filters.limit), 1),
    filters: {
      lang: filters.lang,
      category: filters.category,
      year: filters.year,
      month: filters.month,
      tag: filters.tag,
    },
    usedLanguageFallback: false,
  };
}

async function getPublishedViralVideoBySlugFromFile(slug) {
  const candidates = getSlugCandidates(slug);
  if (!candidates.length) return null;
  const all = await readViralVideoFileRecords();
  const doc = all.find((item) => isPublishedViralVideoRecord(item) && candidates.includes(String(item.slug || '').trim().toLowerCase()));
  return toPublicViralVideoDetail(doc);
}

async function listAllViralVideosFromFile(rawQuery = {}) {
  const filters = parseArchiveFilters(rawQuery);
  const page = parsePositiveInt(rawQuery.page, 1, { min: 1, max: 100000 });
  const limit = parsePositiveInt(rawQuery.limit, 20, { min: 1, max: 100 });
  const all = await readViralVideoFileRecords();
  const filtered = all
    .filter((item) => !rawQuery.status || item.status === normalizeStatus(rawQuery.status))
    .filter((item) => !filters.lang || item.language === filters.lang)
    .filter((item) => !filters.category || item.category === normalizeRequiredViralCategory(filters.category))
    .filter((item) => !filters.tag || (Array.isArray(item.tags) ? item.tags : []).includes(filters.tag))
    .filter((item) => {
      if (!filters.publishedAtRange) return true;
      const publishedAt = toDateOrNull(item.publishedAt);
      return publishedAt && publishedAt >= filters.publishedAtRange.start && publishedAt < filters.publishedAtRange.end;
    })
    .sort(buildFileListSort);
  const start = (page - 1) * limit;

  return {
    items: filtered.slice(start, start + limit),
    page,
    limit,
    total: filtered.length,
    totalPages: Math.max(Math.ceil(filtered.length / limit), 1),
  };
}

async function createViralVideoInFile(payload = {}) {
  const now = new Date().toISOString();
  const rows = await readViralVideoFileRecords();
  const baseSlug = slugifyUnicode(payload.title) || `viral-video-${crypto.randomBytes(3).toString('hex')}`;
  let slug = baseSlug;
  if (rows.some((item) => item.slug === slug)) slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
  const record = normalizeFileVideoRecord({
    ...payload,
    id: crypto.randomUUID(),
    _id: undefined,
    slug,
    category: 'viral',
    source: 'News Pulse',
    createdAt: now,
    updatedAt: now,
    publishedAt: payload.status === 'published' ? (payload.publishedAt || now) : null,
  });
  await writeViralVideoFileRecords([record, ...rows]);
  return record;
}

async function updateViralVideoInFile(idOrSlug, payload = {}) {
  const rows = await readViralVideoFileRecords();
  const lookup = String(idOrSlug || '').trim().toLowerCase();
  const index = rows.findIndex((item) => String(item.id || item._id).toLowerCase() === lookup || String(item.slug || '').toLowerCase() === lookup);
  if (index < 0) return null;
  const next = normalizeFileVideoRecord({
    ...rows[index],
    ...payload,
    id: rows[index].id,
    _id: rows[index]._id,
    slug: rows[index].slug,
    category: 'viral',
    source: 'News Pulse',
    updatedAt: new Date().toISOString(),
    publishedAt: payload.status === 'published' && !rows[index].publishedAt ? new Date().toISOString() : (payload.status && payload.status !== 'published' ? null : rows[index].publishedAt),
  });
  rows[index] = next;
  await writeViralVideoFileRecords(rows);
  return next;
}

async function softDeleteViralVideoInFile(idOrSlug) {
  return updateViralVideoInFile(idOrSlug, { isActive: false, status: 'archived', isPublished: false });
}

async function countPublishedViralVideosFromFileInRange(range, excludeIdOrSlug = null) {
  const exclude = String(excludeIdOrSlug || '').trim().toLowerCase();
  const rows = await readViralVideoFileRecords();
  return rows
    .filter((item) => !exclude || (String(item.id || item._id).toLowerCase() !== exclude && String(item.slug || '').toLowerCase() !== exclude))
    .filter((item) => isPublishedViralVideoRecord(item, { publishedAtRange: range })).length;
}

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
  const uploadedCandidate = doc?.videoFileUrl || (isUploadedVideoUrl(doc?.videoUrl) ? doc.videoUrl : null);

  if (uploadedCandidate || explicit === 'uploaded') return uploadedCandidate ? 'uploaded' : 'external';
  if (explicit === 'youtube' || isYouTubeUrl(videoCandidate)) return 'youtube';
  if (explicit === 'x' || isXStatusUrl(videoCandidate)) return 'x';
  if (explicit === 'external') return 'external';

  if (isUploadedVideoUrl(videoCandidate)) return 'uploaded';
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
  const publishedAtRange = getPublishedAtRangeFromQuery(query);
  const date = String(query.date || '').trim().toLowerCase() || null;
  const period = String(query.period || '').trim().toLowerCase() || null;

  return { page, limit, lang, category, year, month, tag, allowFallback, publishedAtRange, date, period };
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
    ],
    status: 'published',
    category: 'viral',
  };

  if (filters.lang) filter.language = filters.lang;
  if (filters.category && filters.category !== 'viral') filter.category = normalizeRequiredViralCategory(filters.category);
  if (filters.tag) filter.tags = filters.tag;

  if (filters.publishedAtRange) {
    filter.publishedAt = { $gte: filters.publishedAtRange.start, $lt: filters.publishedAtRange.end };
  }

  if (!filters.publishedAtRange && (filters.year || filters.month)) {
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
    category: 'viral',
  };

  if (filters.year || filters.month) {
    filter.publishedAt = buildPublishedFilter(filters).publishedAt;
  }
  if (filters.lang) filter.language = filters.lang;
  if (filters.category && filters.category !== 'viral') filter.category = normalizeRequiredViralCategory(filters.category);
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
    description: doc.description || doc.summary || null,
    shortCaption: doc.summary || doc.description || null,
    summary: doc.summary || doc.description || null,
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
    duration: doc.duration || null,
    language: doc.language || null,
    category: doc.category || 'viral',
    source: doc.source || doc.sourceName || 'News Pulse',
    uploadedBy: doc.uploadedBy || null,
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
    description: doc.description || doc.summary || null,
    summary: doc.summary || doc.description || null,
    thumbnailUrl: posterImageUrl || resolveFeaturedThumbnailUrl(doc),
    posterImageUrl: posterImageUrl || resolveFeaturedThumbnailUrl(doc),
    videoUrl: resolvePublicVideoUrl(doc, videoType, videoFileUrl),
    videoFileUrl,
    sourceUrl,
    sourceName: doc.sourceName || null,
    videoType,
    playbackMode,
    language: doc.language || null,
    category: doc.category || 'viral',
    source: doc.source || doc.sourceName || 'News Pulse',
    uploadedBy: doc.uploadedBy || null,
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

async function countPublishedViralVideosInRange(range, excludeId = null) {
  const filter = {
    $and: [buildActiveFilterClause()],
    status: 'published',
    category: 'viral',
    publishedAt: { $gte: range.start, $lt: range.end },
  };
  if (excludeId && /^[a-f0-9]{24}$/i.test(String(excludeId))) {
    filter._id = { $ne: excludeId };
  }
  return ViralVideo.countDocuments(filter);
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
    ],
    status: 'published',
    category: 'viral',
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
    ],
    status: 'published',
    category: 'viral',
    slug: candidates.length === 1 ? candidates[0] : { $in: candidates },
  }).lean();
  if (!baseDoc) return null;

  const limit = parsePositiveInt(rawQuery.limit, 6, { min: 1, max: 12 });
  const relatedFilter = {
    $and: [
      buildActiveFilterClause(),
      buildGlobalFrontendFilterClause(),
    ],
    status: 'published',
    category: 'viral',
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
  listPublishedViralVideosFromFile,
  listFeaturedViralVideos,
  getPublishedViralVideoBySlug,
  getPublishedViralVideoBySlugFromFile,
  listRelatedPublishedViralVideos,
  listAllViralVideosFromFile,
  createViralVideoInFile,
  updateViralVideoInFile,
  softDeleteViralVideoInFile,
  countPublishedViralVideosInRange,
  countPublishedViralVideosFromFileInRange,
  getIstTodayDateString,
  getIstDateRange,
  getPublishedAtRangeFromQuery,
  IST_TIMEZONE,
  VIRAL_VIDEO_DAILY_PUBLISH_LIMIT,
  toPublicViralVideoCard,
  toPublicViralVideoDetail,
  toPublicViralVideoTeaser,
  toPublicFeaturedViralVideo,
  parseArchiveFilters,
  normalizeLang,
};
