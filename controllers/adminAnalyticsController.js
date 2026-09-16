const mongoose = require('mongoose');

const Article = require('../models/Article');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsDaily = require('../models/ArticleAnalyticsDaily');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const Ad = require('../models/Ad');
const AdPerformanceDaily = require('../models/AdPerformanceDaily');
const FinanceRecord = require('../models/FinanceRecord');

const EMPTY_AD_METRICS = Object.freeze({
  impressions: 0,
  clicks: 0,
  ctr: 0,
  totalAds: 0,
  activeAds: 0,
});

const EMPTY_REVENUE_METRICS = Object.freeze({
  totalRevenue: 0,
  paidAmount: 0,
  outstandingAmount: 0,
  recordCount: 0,
  invoiceTotal: 0,
  invoiceCount: 0,
  revenueRecordCount: 0,
  receiptCount: 0,
  expenseTotal: 0,
  expenseCount: 0,
  currencyBreakdown: [],
});

const PAID_FINANCE_STATUSES = Object.freeze(['paid', 'received', 'completed', 'settled']);
const CLOSED_UNPAID_FINANCE_STATUSES = Object.freeze(['cancelled', 'canceled', 'void', 'written_off', 'written off']);

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function parseIntSafe(v, def) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function utcDateKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

function normalizeDateKey(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function parseQueryDate(value, boundary) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const raw = String(value || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return { ok: false, message: `${boundary === 'end' ? 'dateTo' : 'dateFrom'} must be a valid date` };
  return { ok: true, value: date };
}

function parseQueryDateRange(query) {
  const from = parseQueryDate(query && query.dateFrom, 'start');
  if (!from.ok) return from;
  const to = parseQueryDate(query && query.dateTo, 'end');
  if (!to.ok) return to;
  if (from.value && to.value && to.value.getTime() < from.value.getTime()) {
    return { ok: false, message: 'dateTo must be greater than or equal to dateFrom' };
  }
  return { ok: true, dateFrom: from.value, dateTo: to.value };
}

function adAnalyticsErrorPayload(message) {
  return {
    ok: false,
    success: false,
    source: 'ads_manager',
    connected: false,
    metrics: { ...EMPTY_AD_METRICS },
    scope: 'lifetime',
    dateRangeSupported: false,
    message,
  };
}

function revenueAnalyticsErrorPayload(message) {
  return {
    ok: false,
    success: false,
    source: 'finance_records',
    connected: false,
    metrics: { ...EMPTY_REVENUE_METRICS },
    dateRangeSupported: true,
    dateField: 'paidAt, dueDate, createdAt',
    message,
  };
}

function parseDateRange(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const now = new Date();
  if (s === 'last24h') {
    const start = new Date(now.getTime() - 24 * 60 * 60_000);
    return { kind: 'datetime', start, end: now };
  }
  if (s === 'last7d') {
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    return { kind: 'dateKey', startKey: utcDateKey(start), endKey: utcDateKey(now) };
  }
  if (s === 'last30d') {
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    return { kind: 'dateKey', startKey: utcDateKey(start), endKey: utcDateKey(now) };
  }

  const parts = s.includes('..') ? s.split('..') : s.split(',');
  if (parts.length === 2) {
    const startKey = normalizeDateKey(parts[0]);
    const endKey = normalizeDateKey(parts[1]);
    if (startKey && endKey) return { kind: 'dateKey', startKey, endKey };
  }

  return null;
}

function sortBreakdown(arr, keyField) {
  const items = Array.isArray(arr) ? arr : [];
  return items
    .map((x) => ({
      [keyField]: x && x[keyField] ? x[keyField] : null,
      count: typeof x?.count === 'number' ? x.count : 0,
    }))
    .filter((x) => x[keyField] && x.count > 0)
    .sort((a, b) => b.count - a.count);
}

function parseAnalyticsRange(query = {}) {
  const fromToRequested = query.dateFrom !== undefined || query.dateTo !== undefined;
  if (fromToRequested) {
    const dateRange = parseQueryDateRange(query);
    if (!dateRange.ok) return dateRange;
    return {
      ok: true,
      scope: 'custom',
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
    };
  }

  const raw = String(query.dateRange || query.range || query.period || '').trim().toLowerCase();
  if (!raw || raw === 'all' || raw === 'lifetime') {
    return { ok: true, scope: 'lifetime', dateFrom: null, dateTo: null };
  }

  const now = new Date();
  if (raw === 'last24h' || raw === '24h') {
    return { ok: true, scope: 'last24h', dateFrom: new Date(now.getTime() - 24 * 60 * 60_000), dateTo: now };
  }
  if (raw === 'today') {
    return {
      ok: true,
      scope: 'today',
      dateFrom: new Date(`${utcDateKey(now)}T00:00:00.000Z`),
      dateTo: new Date(`${utcDateKey(now)}T23:59:59.999Z`),
    };
  }
  if (raw === 'last7d' || raw === '7d') {
    return { ok: true, scope: 'last7d', dateFrom: new Date(now.getTime() - 7 * 24 * 60 * 60_000), dateTo: now };
  }
  if (raw === 'last30d' || raw === '30d') {
    return { ok: true, scope: 'last30d', dateFrom: new Date(now.getTime() - 30 * 24 * 60 * 60_000), dateTo: now };
  }

  const parts = raw.includes('..') ? raw.split('..') : raw.split(',');
  if (parts.length === 2) {
    const dateRange = parseQueryDateRange({ dateFrom: parts[0], dateTo: parts[1] });
    if (!dateRange.ok) return dateRange;
    return { ok: true, scope: 'custom', dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo };
  }

  return { ok: false, message: 'dateRange must be lifetime, today, last24h, last7d, last30d, or YYYY-MM-DD..YYYY-MM-DD' };
}

function analyticsScopePayload(range) {
  return {
    scope: range.scope,
    dateRange: {
      dateFrom: range.dateFrom ? range.dateFrom.toISOString() : null,
      dateTo: range.dateTo ? range.dateTo.toISOString() : null,
      semantics: range.scope === 'today' ? 'UTC calendar day' : (range.scope === 'lifetime' ? 'all stored analytics events' : 'rolling createdAt range'),
    },
  };
}

function analyticsEventMatch(range, extra = {}) {
  const match = { ...extra };
  if (range.dateFrom || range.dateTo) {
    match.createdAt = {};
    if (range.dateFrom) match.createdAt.$gte = range.dateFrom;
    if (range.dateTo) match.createdAt.$lte = range.dateTo;
  }
  return match;
}

function eventMetricsGroup(_id) {
  return {
    $group: {
      _id,
      views: { $sum: { $cond: [{ $eq: ['$eventType', 'view'] }, 1, 0] } },
      visitorIds: { $addToSet: { $cond: [{ $eq: ['$eventType', 'view'] }, '$visitorId', null] } },
      engagedReads: { $sum: { $cond: [{ $eq: ['$eventType', 'engaged_read'] }, 1, 0] } },
      totalReadTimeSec: { $sum: { $cond: [{ $eq: ['$eventType', 'heartbeat'] }, { $ifNull: ['$readTimeSec', 0] }, 0] } },
      scroll100Count: { $sum: { $cond: [{ $eq: ['$eventType', 'scroll_100'] }, 1, 0] } },
      slug: { $last: '$slug' },
      category: { $last: '$category' },
      language: { $last: '$language' },
    },
  };
}

function eventMetricsProject(extra = {}) {
  return {
    $project: {
      ...extra,
      views: 1,
      visitorIds: { $setDifference: ['$visitorIds', [null, '']] },
      uniqueReaders: { $size: { $setDifference: ['$visitorIds', [null, '']] } },
      engagedReads: 1,
      totalReadTimeSec: 1,
      scroll100Count: 1,
      slug: 1,
      category: 1,
      language: 1,
      avgReadTimeSec: { $cond: [{ $gt: ['$views', 0] }, { $divide: ['$totalReadTimeSec', '$views'] }, 0] },
      completionRate: { $cond: [{ $gt: ['$views', 0] }, { $divide: ['$scroll100Count', '$views'] }, 0] },
    },
  };
}

async function aggregateEventMetricsByArticle(range, articleIds = null) {
  const match = analyticsEventMatch(range, {
    eventType: { $in: ['view', 'engaged_read', 'heartbeat', 'scroll_100'] },
  });
  if (Array.isArray(articleIds)) {
    if (!articleIds.length) return [];
    match.articleId = { $in: articleIds };
  }
  return ArticleAnalyticsEvent.aggregate([
    { $match: match },
    eventMetricsGroup('$articleId'),
    eventMetricsProject({ articleId: '$_id' }),
    { $sort: { views: -1 } },
  ]);
}

async function aggregateOverallEventMetrics(range) {
  const rows = await ArticleAnalyticsEvent.aggregate([
    { $match: analyticsEventMatch(range, { eventType: { $in: ['view', 'engaged_read', 'heartbeat', 'scroll_100'] } }) },
    eventMetricsGroup(null),
    eventMetricsProject({ _id: 0 }),
  ]);
  const row = rows && rows[0] ? rows[0] : null;
  return {
    views: row ? Number(row.views || 0) : 0,
    uniqueReaders: row ? Number(row.uniqueReaders || 0) : 0,
    engagedReads: row ? Number(row.engagedReads || 0) : 0,
    totalReadTimeSec: row ? Number(row.totalReadTimeSec || 0) : 0,
    scroll100Count: row ? Number(row.scroll100Count || 0) : 0,
    avgReadTimeSec: row ? Number(row.avgReadTimeSec || 0) : 0,
    completionRate: row ? Number(row.completionRate || 0) : 0,
  };
}

function articleIdKey(value) {
  return value == null ? '' : String(value);
}

function toAnalyticsArticleRow(article, metric = {}) {
  const views = Number(metric.views || 0);
  const uniqueReaders = Number(metric.uniqueReaders || 0);
  const engagedReads = Number(metric.engagedReads || 0);
  const totalReadTimeSec = Number(metric.totalReadTimeSec || 0);
  const scroll100Count = Number(metric.scroll100Count || 0);
  return {
    articleId: articleIdKey(article?._id || article?.articleId || metric.articleId),
    title: article?.title || null,
    slug: article?.slug || metric.slug || null,
    category: article?.category || metric.category || null,
    language: article?.language || metric.language || null,
    status: article?.status || null,
    publishedAt: article?.publishedAt || null,
    views,
    readers: uniqueReaders,
    uniqueReaders,
    engagedReads,
    avgReadTimeSec: views > 0 ? totalReadTimeSec / views : 0,
    completionRate: views > 0 ? scroll100Count / views : 0,
    totalViews: views,
    totalUniqueReaders: uniqueReaders,
    totalEngagedReads: engagedReads,
  };
}

function buildArticleAnalyticsFilter(req) {
  const filter = {};
  const category = req.query.category && req.query.category !== 'all' ? String(req.query.category).trim() : null;
  const language = req.query.language && req.query.language !== 'all' ? String(req.query.language).trim() : null;
  const statusRaw = req.query.status !== undefined ? String(req.query.status || '').trim() : '';
  const status = statusRaw && statusRaw !== 'all' ? statusRaw : null;

  if (category) filter.category = category;
  if (language) filter.language = language;
  if (status) filter.status = status;
  else if (statusRaw !== 'all') filter.status = 'published';

  return filter;
}

function buildActiveArticleRecordFilter(base = {}) {
  const clauses = [];
  if (base && Object.keys(base).length) clauses.push(base);
  clauses.push(
    { $or: [{ status: { $ne: 'deleted' } }, { status: { $exists: false } }] },
    { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] }
  );
  return { $and: clauses };
}

function mergeCategoryMetric(categories, row) {
  const category = row.category || 'uncategorized';
  const existing = categories.get(category) || {
    category,
    views: 0,
    uniqueReaders: 0,
    engagedReads: 0,
    totalReadTimeSec: 0,
    scroll100Count: 0,
    topArticles: [],
    visitorIds: new Set(),
  };
  existing.views += Number(row.views || 0);
  for (const visitorId of Array.isArray(row.visitorIds) ? row.visitorIds : []) {
    if (visitorId) existing.visitorIds.add(String(visitorId));
  }
  existing.uniqueReaders = existing.visitorIds.size;
  existing.engagedReads += Number(row.engagedReads || 0);
  existing.totalReadTimeSec += Number(row.totalReadTimeSec || 0);
  existing.scroll100Count += Number(row.scroll100Count || 0);
  if (Number(row.views || 0) > 0) {
    const { visitorIds: _visitorIds, ...publicRow } = row;
    existing.topArticles.push(publicRow);
  }
  categories.set(category, existing);
}

async function getDashboard(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(200).json({ ok: true, data: {
        totalViews: 0,
        totalUniqueReaders: 0,
        uniqueReaders: 0,
        uniqueVisitors: 0,
        totalEngagedReads: 0,
        avgReadTimeSec: 0,
        completionRate: 0,
        topSources: [],
        languageBreakdown: [],
        topArticles: [],
        categoryBreakdown: [],
        last24hViews: 0,
        last7dViews: 0,
        scope: 'lifetime',
        dateRange: { dateFrom: null, dateTo: null, semantics: 'all stored analytics events' },
      }});
    }

    const range = parseAnalyticsRange(req.query || {});
    if (!range.ok) return res.status(400).json({ ok: false, message: range.message });

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60_000);

    const [totals, topSourcesAgg, langAgg, articleMetrics, last24hViews, last7dViews] = await Promise.all([
      aggregateOverallEventMetrics(range),
      ArticleAnalyticsEvent.aggregate([
        { $match: analyticsEventMatch(range, { eventType: 'view' }) },
        { $group: { _id: { $ifNull: ['$source', 'unknown'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      ArticleAnalyticsEvent.aggregate([
        { $match: analyticsEventMatch(range, { eventType: 'view' }) },
        { $group: { _id: { $ifNull: ['$language', 'unknown'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      aggregateEventMetricsByArticle(range),
      ArticleAnalyticsEvent.countDocuments({ eventType: 'view', createdAt: { $gte: since24h } }),
      ArticleAnalyticsEvent.countDocuments({ eventType: 'view', createdAt: { $gte: since7d } }),
    ]);

    const articleIds = (articleMetrics || []).map((row) => row.articleId).filter(Boolean);
    const articles = articleIds.length ? await Article.find(buildActiveArticleRecordFilter({ _id: { $in: articleIds }, status: 'published' }))
      .select('title slug category language status publishedAt deletedAt')
      .lean() : [];
    const byId = new Map((articles || []).map((a) => [String(a._id), a]));

    const articleRows = (articleMetrics || []).map((metric) => toAnalyticsArticleRow(byId.get(String(metric.articleId)), metric));
    const topArticles = articleRows
      .slice()
      .sort((a, b) => b.views - a.views || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, 10);

    const categoryMap = new Map();
    for (const metric of articleMetrics || []) {
      const row = toAnalyticsArticleRow(byId.get(String(metric.articleId)), metric);
      if (row.views > 0) {
        mergeCategoryMetric(categoryMap, {
          ...row,
          category: row.category,
          visitorIds: metric.visitorIds,
          totalReadTimeSec: metric.totalReadTimeSec,
          scroll100Count: metric.scroll100Count,
        });
      }
    }
    const categoryBreakdown = Array.from(categoryMap.values()).map((c) => {
      const views = c.views || 0;
      const totalRead = c.totalReadTimeSec || 0;
      const scroll100 = c.scroll100Count || 0;
      return {
        category: c.category,
        views,
        readers: c.uniqueReaders || 0,
        uniqueReaders: c.uniqueReaders || 0,
        engagedReads: c.engagedReads || 0,
        avgReadTimeSec: views > 0 ? totalRead / views : 0,
        completionRate: views > 0 ? scroll100 / views : 0,
        topArticles: c.topArticles
          .slice()
          .sort((a, b) => b.views - a.views || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
          .slice(0, 3),
      };
    }).sort((a, b) => b.views - a.views);

    const topSources = (topSourcesAgg || []).map((x) => ({ source: x._id, count: x.count }));
    const languageBreakdown = (langAgg || []).map((x) => ({ language: x._id, count: x.count }));
    const totalViews = totals.views;
    const totalUniqueReaders = totals.uniqueReaders;

    return res.status(200).json({
      ok: true,
      data: {
        totalViews,
        views: totalViews,
        totalUniqueReaders,
        uniqueReaders: totalUniqueReaders,
        uniqueVisitors: totalUniqueReaders,
        totalEngagedReads: totals.engagedReads,
        engagedReads: totals.engagedReads,
        avgReadTimeSec: totals.avgReadTimeSec,
        completionRate: totals.completionRate,
        topSources,
        languageBreakdown,
        topArticles,
        categoryBreakdown,
        last24hViews,
        last7dViews,
        ...analyticsScopePayload(range),
      },
    });
  } catch (e) {
    console.error('[admin-analytics][dashboard] failed', e?.message || e);
    return res.status(200).json({ ok: true, data: {
      totalViews: 0,
      totalUniqueReaders: 0,
      uniqueReaders: 0,
      uniqueVisitors: 0,
      totalEngagedReads: 0,
      avgReadTimeSec: 0,
      completionRate: 0,
      topSources: [],
      languageBreakdown: [],
      topArticles: [],
      categoryBreakdown: [],
      last24hViews: 0,
      last7dViews: 0,
      scope: 'lifetime',
      dateRange: { dateFrom: null, dateTo: null, semantics: 'all stored analytics events' },
    }});
  }
}

async function listArticles(req, res) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, items: [], total: 0, page: 1, pageSize: 20 });

    const page = Math.max(parseIntSafe(req.query.page, 1), 1);
    const pageSize = Math.min(Math.max(parseIntSafe(req.query.limit ?? req.query.pageSize, 20), 1), 100);
    const skip = (page - 1) * pageSize;
    const range = parseAnalyticsRange(req.query || {});
    if (!range.ok) return res.status(400).json({ ok: false, message: range.message });

    const articleFilter = buildActiveArticleRecordFilter(buildArticleAnalyticsFilter(req));
    const articles = await Article.find(articleFilter)
      .select('title slug status publishedAt category language deletedAt')
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();
    const articleIds = (articles || []).map((article) => article._id).filter(Boolean);
    const metrics = await aggregateEventMetricsByArticle(range, articleIds);
    const byId = new Map((metrics || []).map((metric) => [String(metric.articleId), metric]));

    const allItems = (articles || [])
      .map((article) => toAnalyticsArticleRow(article, byId.get(String(article._id))))
      .sort((a, b) => b.views - a.views || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const total = allItems.length;
    const items = allItems.slice(skip, skip + pageSize);

    return res.status(200).json({ ok: true, items, total, page, pageSize, ...analyticsScopePayload(range) });
  } catch (e) {
    console.error('[admin-analytics][articles] failed', e?.message || e);
    return res.status(200).json({ ok: true, items: [], total: 0, page: 1, pageSize: 20 });
  }
}

async function getArticleDetails(req, res) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, data: null });

    const articleId = String(req.params.articleId || '').trim();
    if (!mongoose.isValidObjectId(articleId)) return res.status(400).json({ ok: false, message: 'Invalid articleId' });

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);

    const [article, summary, last24hViews, daily30d] = await Promise.all([
      Article.findById(articleId).select('title slug category language status publishedAt').lean(),
      ArticleAnalyticsSummary.findOne({ articleId }).lean(),
      ArticleAnalyticsEvent.countDocuments({ articleId, eventType: 'view', createdAt: { $gte: since24h } }),
      ArticleAnalyticsDaily.find({
        articleId,
        dateKey: { $gte: utcDateKey(new Date(now.getTime() - 30 * 24 * 60 * 60_000)), $lte: utcDateKey(now) },
      }).sort({ dateKey: 1 }).lean(),
    ]);

    const sum7d = (daily30d || [])
      .filter((d) => d.dateKey >= utcDateKey(new Date(now.getTime() - 7 * 24 * 60 * 60_000)))
      .reduce((acc, d) => {
        acc.views += d.views || 0;
        acc.uniqueReaders += d.uniqueReaders || 0;
        acc.engagedReads += d.engagedReads || 0;
        acc.totalReadTimeSec += d.totalReadTimeSec || 0;
        acc.scroll25 += d.scroll25Count || 0;
        acc.scroll50 += d.scroll50Count || 0;
        acc.scroll75 += d.scroll75Count || 0;
        acc.scroll100 += d.scroll100Count || 0;
        return acc;
      }, { views: 0, uniqueReaders: 0, engagedReads: 0, totalReadTimeSec: 0, scroll25: 0, scroll50: 0, scroll75: 0, scroll100: 0 });

    const sum30d = (daily30d || []).reduce((acc, d) => {
      acc.views += d.views || 0;
      acc.uniqueReaders += d.uniqueReaders || 0;
      acc.engagedReads += d.engagedReads || 0;
      acc.totalReadTimeSec += d.totalReadTimeSec || 0;
      acc.scroll25 += d.scroll25Count || 0;
      acc.scroll50 += d.scroll50Count || 0;
      acc.scroll75 += d.scroll75Count || 0;
      acc.scroll100 += d.scroll100Count || 0;
      return acc;
    }, { views: 0, uniqueReaders: 0, engagedReads: 0, totalReadTimeSec: 0, scroll25: 0, scroll50: 0, scroll75: 0, scroll100: 0 });

    const totals = {
      totalViews: summary?.totalViews || 0,
      totalUniqueReaders: summary?.totalUniqueReaders || 0,
      totalEngagedReads: summary?.totalEngagedReads || 0,
      avgReadTimeSec: summary?.avgReadTimeSec || 0,
      completionRate: summary?.completionRate || 0,
      scroll25Count: summary?.scroll25Count || 0,
      scroll50Count: summary?.scroll50Count || 0,
      scroll75Count: summary?.scroll75Count || 0,
      scroll100Count: summary?.scroll100Count || 0,
      sourceBreakdown: sortBreakdown(summary?.sourceBreakdown, 'source'),
      languageBreakdown: sortBreakdown(summary?.languageBreakdown, 'language'),
    };

    const trend = (daily30d || []).map((d) => ({
      dateKey: d.dateKey,
      views: d.views || 0,
      uniqueReaders: d.uniqueReaders || 0,
      engagedReads: d.engagedReads || 0,
      avgReadTimeSec: d.avgReadTimeSec || (d.views ? (d.totalReadTimeSec || 0) / d.views : 0),
      scroll25Count: d.scroll25Count || 0,
      scroll50Count: d.scroll50Count || 0,
      scroll75Count: d.scroll75Count || 0,
      scroll100Count: d.scroll100Count || 0,
      completionRate: d.completionRate || (d.views ? (d.scroll100Count || 0) / d.views : 0),
    }));

    return res.status(200).json({
      ok: true,
      data: {
        article: {
          articleId,
          title: article?.title || null,
          slug: article?.slug || summary?.slug || null,
          category: article?.category || summary?.category || null,
          language: article?.language || summary?.language || null,
          status: article?.status || null,
          publishedAt: article?.publishedAt || null,
        },
        totals,
        last24h: { views: last24hViews },
        last7d: {
          views: sum7d.views,
          uniqueReaders: sum7d.uniqueReaders,
          engagedReads: sum7d.engagedReads,
          avgReadTimeSec: sum7d.views ? sum7d.totalReadTimeSec / sum7d.views : 0,
          completionRate: sum7d.views ? sum7d.scroll100 / sum7d.views : 0,
          scrollFunnel: {
            scroll25: sum7d.scroll25,
            scroll50: sum7d.scroll50,
            scroll75: sum7d.scroll75,
            scroll100: sum7d.scroll100,
          },
        },
        last30d: {
          views: sum30d.views,
          uniqueReaders: sum30d.uniqueReaders,
          engagedReads: sum30d.engagedReads,
          avgReadTimeSec: sum30d.views ? sum30d.totalReadTimeSec / sum30d.views : 0,
          completionRate: sum30d.views ? sum30d.scroll100 / sum30d.views : 0,
          scrollFunnel: {
            scroll25: sum30d.scroll25,
            scroll50: sum30d.scroll50,
            scroll75: sum30d.scroll75,
            scroll100: sum30d.scroll100,
          },
        },
        scrollFunnel: {
          scroll25: totals.scroll25Count,
          scroll50: totals.scroll50Count,
          scroll75: totals.scroll75Count,
          scroll100: totals.scroll100Count,
        },
        sourceBreakdown: totals.sourceBreakdown,
        languageBreakdown: totals.languageBreakdown,
        recentTrend: trend,
      },
    });
  } catch (e) {
    console.error('[admin-analytics][article-details] failed', e?.message || e);
    return res.status(200).json({ ok: true, data: null });
  }
}

function roundPercentage(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.round(Number(value) * 10000) / 10000;
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function adPerformanceDailyRange(range) {
  const now = range.dateTo || new Date();
  let startKey = range.dateFrom ? utcDateKey(range.dateFrom) : null;
  let endKey = range.dateTo ? utcDateKey(range.dateTo) : null;

  if (range.scope === 'today') {
    startKey = utcDateKey(now);
    endKey = startKey;
  } else if (range.scope === 'last7d') {
    endKey = utcDateKey(now);
    startKey = utcDateKey(addUtcDays(new Date(`${endKey}T00:00:00.000Z`), -6));
  } else if (range.scope === 'last30d') {
    endKey = utcDateKey(now);
    startKey = utcDateKey(addUtcDays(new Date(`${endKey}T00:00:00.000Z`), -29));
  } else if (range.scope === 'last24h') {
    startKey = utcDateKey(range.dateFrom || addUtcDays(now, -1));
    endKey = utcDateKey(now);
  }

  if (startKey && endKey && endKey < startKey) {
    return { ok: false, message: 'dateTo must be greater than or equal to dateFrom' };
  }

  return { ok: true, startKey, endKey };
}

async function leanResult(query) {
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

async function findAdPublicSummaries(adIds) {
  if (!adIds.length) return new Map();
  const query = Ad.find({ _id: { $in: adIds } });
  const selected = query && typeof query.select === 'function'
    ? query.select({ _id: 1, title: 1, slot: 1, isActive: 1 })
    : query;
  const docs = await leanResult(selected);
  return new Map((docs || []).map((ad) => [String(ad._id), ad]));
}

function toCtr(impressions, clicks) {
  return impressions > 0 ? roundPercentage((clicks / impressions) * 100) : 0;
}

function mergeAdPerformanceRow(map, key, seed, impressions, clicks) {
  const current = map.get(key) || { ...seed, impressions: 0, clicks: 0 };
  current.impressions += impressions;
  current.clicks += clicks;
  map.set(key, current);
  return current;
}

async function getAdPerformanceHistory(req, res, range) {
  const dateKeys = adPerformanceDailyRange(range);
  if (!dateKeys.ok) {
    return res.status(400).json({ ok: false, success: false, source: 'ads_manager', connected: false, message: dateKeys.message });
  }

  const match = {};
  if (dateKeys.startKey || dateKeys.endKey) {
    match.dateKey = {};
    if (dateKeys.startKey) match.dateKey.$gte = dateKeys.startKey;
    if (dateKeys.endKey) match.dateKey.$lte = dateKeys.endKey;
  }

  const dailyRows = await leanResult(AdPerformanceDaily.find(match));
  const adIds = Array.from(new Set((dailyRows || []).map((row) => row.adId).filter(Boolean).map((id) => String(id))));
  const adsById = await findAdPublicSummaries(adIds);
  const totals = { impressions: 0, clicks: 0 };
  const daily = new Map();
  const perAd = new Map();
  const placements = new Map();

  for (const row of dailyRows || []) {
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    const dateKey = normalizeDateKey(row.dateKey);
    const adId = row.adId ? String(row.adId) : null;
    const ad = adId ? adsById.get(adId) : null;
    const slot = row.slot || (ad && ad.slot) || null;

    totals.impressions += impressions;
    totals.clicks += clicks;

    if (dateKey) {
      mergeAdPerformanceRow(daily, dateKey, { date: dateKey, dateKey }, impressions, clicks);
    }
    if (adId) {
      mergeAdPerformanceRow(perAd, adId, {
        adId,
        title: ad && typeof ad.title === 'string' ? ad.title : '',
        slot: ad && ad.slot ? ad.slot : slot,
        isActive: ad ? ad.isActive === true : false,
      }, impressions, clicks);
    }
    if (slot) {
      const placement = mergeAdPerformanceRow(placements, slot, { slot, adIds: new Set() }, impressions, clicks);
      if (adId) placement.adIds.add(adId);
    }
  }

  const dailyTrend = Array.from(daily.values())
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((row) => ({ ...row, ctr: toCtr(row.impressions, row.clicks) }));
  const perAdRows = Array.from(perAd.values())
    .map((row) => ({ ...row, ctr: toCtr(row.impressions, row.clicks) }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.adId.localeCompare(b.adId));
  const placementRows = Array.from(placements.values())
    .map((row) => ({
      slot: row.slot,
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: toCtr(row.impressions, row.clicks),
      adsWithActivity: row.adIds.size,
    }))
    .sort((a, b) => b.impressions - a.impressions || a.slot.localeCompare(b.slot));

  return res.status(200).json({
    ok: true,
    success: true,
    source: 'ads_manager',
    connected: true,
    metrics: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: toCtr(totals.impressions, totals.clicks),
      adsWithActivity: perAdRows.length,
      activeAds: perAdRows.filter((row) => row.isActive).length,
    },
    scope: range.scope,
    dateRangeSupported: true,
    dateGranularity: 'day',
    dateRange: {
      dateFrom: dateKeys.startKey ? `${dateKeys.startKey}T00:00:00.000Z` : null,
      dateTo: dateKeys.endKey ? `${dateKeys.endKey}T23:59:59.999Z` : null,
      semantics: 'UTC calendar day keys from ad performance records',
    },
    dailyTrend,
    perAd: perAdRows,
    placements: placementRows,
    topAds: {
      byImpressions: perAdRows.slice(0, 10),
      byClicks: perAdRows.slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.adId.localeCompare(b.adId)).slice(0, 10),
      byCtr: perAdRows.slice().sort((a, b) => b.ctr - a.ctr || b.impressions - a.impressions || a.adId.localeCompare(b.adId)).slice(0, 10),
    },
  });
}

async function getAdPerformance(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(200).json(adAnalyticsErrorPayload('Database unavailable'));
    }

    const range = parseAnalyticsRange(req.query || {});
    if (!range.ok) {
      return res.status(400).json({ ok: false, success: false, source: 'ads_manager', connected: false, message: range.message });
    }
    if (range.scope !== 'lifetime') {
      return getAdPerformanceHistory(req, res, range);
    }

    const rows = await Ad.aggregate([
      {
        $group: {
          _id: null,
          impressions: { $sum: { $ifNull: ['$stats.impressions', 0] } },
          clicks: { $sum: { $ifNull: ['$stats.clicks', 0] } },
          totalAds: { $sum: 1 },
          activeAds: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
        },
      },
    ]);

    const row = rows && rows[0] ? rows[0] : {};
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);

    return res.status(200).json({
      ok: true,
      success: true,
      source: 'ads_manager',
      connected: true,
      metrics: {
        impressions,
        clicks,
        ctr: impressions > 0 ? roundPercentage((clicks / impressions) * 100) : 0,
        totalAds: Number(row.totalAds || 0),
        activeAds: Number(row.activeAds || 0),
      },
      scope: 'lifetime',
      dateRangeSupported: false,
    });
  } catch (_e) {
    console.error('[admin-analytics][ad-performance] failed');
    return res.status(200).json(adAnalyticsErrorPayload('Ad performance source unavailable'));
  }
}

function buildRevenueAggregationPipeline(dateFrom, dateTo) {
  const pipeline = [
    {
      $addFields: {
        normalizedStatus: { $toLower: { $ifNull: ['$status', ''] } },
        amountValue: { $ifNull: ['$amount', 0] },
        analyticsDate: {
          $switch: {
            branches: [
              { case: { $ne: ['$paidAt', null] }, then: '$paidAt' },
              { case: { $eq: ['$type', 'invoice'] }, then: { $ifNull: ['$dueDate', '$createdAt'] } },
            ],
            default: '$createdAt',
          },
        },
      },
    },
  ];

  if (dateFrom || dateTo) {
    const match = {};
    if (dateFrom) match.$gte = dateFrom;
    if (dateTo) match.$lte = dateTo;
    pipeline.push({ $match: { analyticsDate: match } });
  }

  const paidCondition = {
    $or: [
      { $ne: ['$paidAt', null] },
      { $in: ['$normalizedStatus', PAID_FINANCE_STATUSES] },
    ],
  };
  const outstandingInvoiceCondition = {
    $and: [
      { $eq: ['$type', 'invoice'] },
      { $not: [paidCondition] },
      { $not: [{ $in: ['$normalizedStatus', CLOSED_UNPAID_FINANCE_STATUSES] }] },
    ],
  };

  pipeline.push({
    $facet: {
      totals: [
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: { $cond: [{ $eq: ['$type', 'revenue'] }, '$amountValue', 0] } },
            paidAmount: { $sum: { $cond: [{ $and: [{ $in: ['$type', ['invoice', 'revenue']] }, paidCondition] }, '$amountValue', 0] } },
            outstandingAmount: { $sum: { $cond: [outstandingInvoiceCondition, '$amountValue', 0] } },
            recordCount: { $sum: 1 },
            invoiceTotal: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, '$amountValue', 0] } },
            invoiceCount: { $sum: { $cond: [{ $eq: ['$type', 'invoice'] }, 1, 0] } },
            revenueRecordCount: { $sum: { $cond: [{ $eq: ['$type', 'revenue'] }, 1, 0] } },
            receiptCount: { $sum: { $cond: [{ $eq: ['$type', 'receipt'] }, 1, 0] } },
            expenseTotal: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amountValue', 0] } },
            expenseCount: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, 1, 0] } },
          },
        },
      ],
      currencyBreakdown: [
        {
          $group: {
            _id: { $ifNull: ['$currency', 'INR'] },
            amount: { $sum: '$amountValue' },
            count: { $sum: 1 },
          },
        },
        { $sort: { amount: -1, _id: 1 } },
      ],
    },
  });

  return pipeline;
}

async function getRevenueAnalytics(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(200).json(revenueAnalyticsErrorPayload('Database unavailable'));
    }

    const dateRange = parseQueryDateRange(req.query || {});
    if (!dateRange.ok) {
      return res.status(400).json({
        ok: false,
        success: false,
        source: 'finance_records',
        connected: false,
        message: dateRange.message,
      });
    }

    const rows = await FinanceRecord.aggregate(buildRevenueAggregationPipeline(dateRange.dateFrom, dateRange.dateTo));
    const result = rows && rows[0] ? rows[0] : {};
    const totals = result.totals && result.totals[0] ? result.totals[0] : {};
    const currencyBreakdown = Array.isArray(result.currencyBreakdown)
      ? result.currencyBreakdown.map((row) => ({
        currency: row && row._id ? String(row._id) : 'INR',
        amount: Number(row && row.amount || 0),
        count: Number(row && row.count || 0),
      }))
      : [];

    return res.status(200).json({
      ok: true,
      success: true,
      source: 'finance_records',
      connected: true,
      metrics: {
        totalRevenue: Number(totals.totalRevenue || 0),
        paidAmount: Number(totals.paidAmount || 0),
        outstandingAmount: Number(totals.outstandingAmount || 0),
        recordCount: Number(totals.recordCount || 0),
        invoiceTotal: Number(totals.invoiceTotal || 0),
        invoiceCount: Number(totals.invoiceCount || 0),
        revenueRecordCount: Number(totals.revenueRecordCount || 0),
        receiptCount: Number(totals.receiptCount || 0),
        expenseTotal: Number(totals.expenseTotal || 0),
        expenseCount: Number(totals.expenseCount || 0),
        currencyBreakdown,
      },
      dateRangeSupported: true,
      dateField: 'paidAt, dueDate, createdAt',
      filters: {
        dateFrom: dateRange.dateFrom ? dateRange.dateFrom.toISOString() : null,
        dateTo: dateRange.dateTo ? dateRange.dateTo.toISOString() : null,
      },
    });
  } catch (_e) {
    console.error('[admin-analytics][revenue] failed');
    return res.status(200).json(revenueAnalyticsErrorPayload('Revenue source unavailable'));
  }
}

async function listCategories(req, res) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, items: [] });

    const range = parseAnalyticsRange(req.query || {});
    if (!range.ok) return res.status(400).json({ ok: false, message: range.message });

    const metrics = await aggregateEventMetricsByArticle(range);
    const articleIds = (metrics || []).map((row) => row.articleId).filter(Boolean);
    const articles = articleIds.length ? await Article.find(buildActiveArticleRecordFilter({ _id: { $in: articleIds }, status: 'published' }))
      .select('title slug status publishedAt category language deletedAt')
      .lean() : [];
    const byId = new Map((articles || []).map((article) => [String(article._id), article]));

    const categories = new Map();
    for (const metric of metrics || []) {
      const article = byId.get(String(metric.articleId));
      if (!article) continue;
      const row = toAnalyticsArticleRow(article, metric);
      if (row.views > 0) {
        mergeCategoryMetric(categories, {
          ...row,
          category: article.category,
          visitorIds: metric.visitorIds,
          totalReadTimeSec: metric.totalReadTimeSec,
          scroll100Count: metric.scroll100Count,
        });
      }
    }

    const items = Array.from(categories.values()).map((category) => {
      const views = category.views || 0;
      return {
        category: category.category,
        views,
        readers: category.uniqueReaders || 0,
        uniqueReaders: category.uniqueReaders || 0,
        engagedReads: category.engagedReads || 0,
        avgReadTimeSec: views > 0 ? (category.totalReadTimeSec || 0) / views : 0,
        completionRate: views > 0 ? (category.scroll100Count || 0) / views : 0,
        topArticles: category.topArticles
          .slice()
          .sort((a, b) => b.views - a.views || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
          .slice(0, 3)
          .map((article) => ({
            articleId: article.articleId,
            title: article.title,
            slug: article.slug,
            status: article.status,
            publishedAt: article.publishedAt,
            views: article.views,
            readers: article.readers,
            uniqueReaders: article.uniqueReaders,
            totalViews: article.totalViews,
          })),
      };
    }).sort((a, b) => b.views - a.views);

    return res.status(200).json({ ok: true, items, ...analyticsScopePayload(range) });
  } catch (e) {
    console.error('[admin-analytics][categories] failed', e?.message || e);
    return res.status(200).json({ ok: true, items: [] });
  }
}

module.exports = {
  getDashboard,
  listArticles,
  getArticleDetails,
  getAdPerformance,
  getRevenueAnalytics,
  listCategories,
};
