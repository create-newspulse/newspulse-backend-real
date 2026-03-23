const mongoose = require('mongoose');

const Article = require('../models/Article');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsDaily = require('../models/ArticleAnalyticsDaily');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');

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

async function getDashboard(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(200).json({ ok: true, data: {
        totalViews: 0,
        totalUniqueReaders: 0,
        totalEngagedReads: 0,
        avgReadTimeSec: 0,
        topSources: [],
        languageBreakdown: [],
        topArticles: [],
        categoryBreakdown: [],
        last24hViews: 0,
        last7dViews: 0,
      }});
    }

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60_000);

    const [totalsAgg, topSourcesAgg, langAgg, categoryAgg, last24hViews, last7dViews, topSummaries] = await Promise.all([
      ArticleAnalyticsSummary.aggregate([
        {
          $group: {
            _id: null,
            totalViews: { $sum: '$totalViews' },
            totalUniqueReaders: { $sum: '$totalUniqueReaders' },
            totalEngagedReads: { $sum: '$totalEngagedReads' },
            totalReadTimeSec: { $sum: '$totalReadTimeSec' },
            totalScroll100: { $sum: '$scroll100Count' },
          },
        },
      ]),
      ArticleAnalyticsSummary.aggregate([
        { $unwind: { path: '$sourceBreakdown', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: '$sourceBreakdown.source',
            count: { $sum: '$sourceBreakdown.count' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      ArticleAnalyticsSummary.aggregate([
        { $unwind: { path: '$languageBreakdown', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: '$languageBreakdown.language',
            count: { $sum: '$languageBreakdown.count' },
          },
        },
        { $sort: { count: -1 } },
      ]),
      ArticleAnalyticsSummary.aggregate([
        {
          $group: {
            _id: '$category',
            views: { $sum: '$totalViews' },
            uniqueReaders: { $sum: '$totalUniqueReaders' },
            engagedReads: { $sum: '$totalEngagedReads' },
            totalReadTimeSec: { $sum: '$totalReadTimeSec' },
            scroll100: { $sum: '$scroll100Count' },
          },
        },
        { $sort: { views: -1 } },
      ]),
      ArticleAnalyticsEvent.countDocuments({ eventType: 'view', createdAt: { $gte: since24h } }),
      ArticleAnalyticsEvent.countDocuments({ eventType: 'view', createdAt: { $gte: since7d } }),
      ArticleAnalyticsSummary.find({}).sort({ totalViews: -1 }).limit(10).lean(),
    ]);

    const totalsRow = totalsAgg && totalsAgg[0] ? totalsAgg[0] : null;
    const totalViews = totalsRow ? totalsRow.totalViews : 0;
    const totalReadTimeSec = totalsRow ? totalsRow.totalReadTimeSec : 0;

    const topArticlesIds = (topSummaries || []).map((d) => d.articleId).filter(Boolean);
    const articles = await Article.find({ _id: { $in: topArticlesIds } })
      .select('title slug category language status publishedAt')
      .lean();
    const byId = new Map((articles || []).map((a) => [String(a._id), a]));

    const topArticles = (topSummaries || []).map((s) => {
      const a = byId.get(String(s.articleId)) || null;
      return {
        articleId: String(s.articleId),
        title: a?.title || null,
        slug: a?.slug || s.slug || null,
        category: a?.category || s.category || null,
        language: a?.language || s.language || null,
        status: a?.status || null,
        publishedAt: a?.publishedAt || null,
        totalViews: s.totalViews || 0,
        totalUniqueReaders: s.totalUniqueReaders || 0,
        totalEngagedReads: s.totalEngagedReads || 0,
        avgReadTimeSec: s.avgReadTimeSec || 0,
        completionRate: s.completionRate || 0,
      };
    });

    const categoryBreakdown = (categoryAgg || []).map((c) => {
      const views = c?.views || 0;
      const totalRead = c?.totalReadTimeSec || 0;
      const scroll100 = c?.scroll100 || 0;
      return {
        category: c?._id || null,
        views,
        uniqueReaders: c?.uniqueReaders || 0,
        engagedReads: c?.engagedReads || 0,
        avgReadTimeSec: views > 0 ? totalRead / views : 0,
        completionRate: views > 0 ? scroll100 / views : 0,
      };
    });

    const topSources = (topSourcesAgg || []).map((x) => ({ source: x._id, count: x.count }));
    const languageBreakdown = (langAgg || []).map((x) => ({ language: x._id, count: x.count }));

    return res.status(200).json({
      ok: true,
      data: {
        totalViews,
        totalUniqueReaders: totalsRow ? totalsRow.totalUniqueReaders : 0,
        totalEngagedReads: totalsRow ? totalsRow.totalEngagedReads : 0,
        avgReadTimeSec: totalViews > 0 ? totalReadTimeSec / totalViews : 0,
        topSources,
        languageBreakdown,
        topArticles,
        categoryBreakdown,
        last24hViews,
        last7dViews,
      },
    });
  } catch (e) {
    console.error('[admin-analytics][dashboard] failed', e?.message || e);
    return res.status(200).json({ ok: true, data: {
      totalViews: 0,
      totalUniqueReaders: 0,
      totalEngagedReads: 0,
      avgReadTimeSec: 0,
      topSources: [],
      languageBreakdown: [],
      topArticles: [],
      categoryBreakdown: [],
      last24hViews: 0,
      last7dViews: 0,
    }});
  }
}

async function listArticles(req, res) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, items: [], total: 0, page: 1, pageSize: 20 });

    const page = Math.max(parseIntSafe(req.query.page, 1), 1);
    const pageSize = Math.min(Math.max(parseIntSafe(req.query.limit ?? req.query.pageSize, 20), 1), 100);
    const skip = (page - 1) * pageSize;

    const category = req.query.category && req.query.category !== 'all' ? String(req.query.category).trim() : null;
    const language = req.query.language && req.query.language !== 'all' ? String(req.query.language).trim() : null;
    const status = req.query.status && req.query.status !== 'all' ? String(req.query.status).trim() : null;

    const dateRange = parseDateRange(req.query.dateRange);

    if (dateRange && dateRange.kind === 'dateKey') {
      // Range mode: compute from daily aggregates
      const match = {
        dateKey: { $gte: dateRange.startKey, $lte: dateRange.endKey },
      };
      if (category) match.category = category;
      if (language) match.language = language;

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: '$articleId',
            articleId: { $first: '$articleId' },
            slug: { $last: '$slug' },
            category: { $last: '$category' },
            language: { $last: '$language' },
            views: { $sum: '$views' },
            uniqueReaders: { $sum: '$uniqueReaders' },
            engagedReads: { $sum: '$engagedReads' },
            totalReadTimeSec: { $sum: '$totalReadTimeSec' },
            scroll100Count: { $sum: '$scroll100Count' },
          },
        },
        { $sort: { views: -1 } },
        { $skip: skip },
        { $limit: pageSize },
      ];

      const countPipeline = [
        { $match: match },
        { $group: { _id: '$articleId' } },
        { $count: 'total' },
      ];

      const [rows, countRows] = await Promise.all([
        ArticleAnalyticsDaily.aggregate(pipeline),
        ArticleAnalyticsDaily.aggregate(countPipeline),
      ]);

      const ids = (rows || []).map((r) => r.articleId);
      let articleFilter = { _id: { $in: ids } };
      if (status) articleFilter.status = status;
      const articles = await Article.find(articleFilter).select('title slug status publishedAt category language').lean();
      const byId = new Map((articles || []).map((a) => [String(a._id), a]));

      const items = (rows || [])
        .map((r) => {
          const a = byId.get(String(r.articleId)) || null;
          if (status && !a) return null;
          const views = r.views || 0;
          return {
            articleId: String(r.articleId),
            title: a?.title || null,
            slug: a?.slug || r.slug || null,
            category: a?.category || r.category || null,
            language: a?.language || r.language || null,
            status: a?.status || null,
            publishedAt: a?.publishedAt || null,
            views,
            uniqueReaders: r.uniqueReaders || 0,
            engagedReads: r.engagedReads || 0,
            avgReadTimeSec: views > 0 ? (r.totalReadTimeSec || 0) / views : 0,
            completionRate: views > 0 ? (r.scroll100Count || 0) / views : 0,
          };
        })
        .filter(Boolean);

      const total = countRows && countRows[0] ? countRows[0].total : 0;
      return res.status(200).json({ ok: true, items, total, page, pageSize });
    }

    // Default mode: use lifetime summary
    const filter = {};
    if (category) filter.category = category;
    if (language) filter.language = language;

    let allowedIds = null;
    if (status) {
      const ids = await Article.find({ status }).distinct('_id');
      allowedIds = ids || [];
      filter.articleId = { $in: allowedIds };
    }

    const [itemsRaw, total] = await Promise.all([
      ArticleAnalyticsSummary.find(filter).sort({ totalViews: -1 }).skip(skip).limit(pageSize).lean(),
      ArticleAnalyticsSummary.countDocuments(filter),
    ]);

    const ids = (itemsRaw || []).map((x) => x.articleId).filter(Boolean);
    const articles = await Article.find({ _id: { $in: ids } })
      .select('title slug status publishedAt category language')
      .lean();
    const byId = new Map((articles || []).map((a) => [String(a._id), a]));

    const items = (itemsRaw || []).map((s) => {
      const a = byId.get(String(s.articleId)) || null;
      return {
        articleId: String(s.articleId),
        title: a?.title || null,
        slug: a?.slug || s.slug || null,
        category: a?.category || s.category || null,
        language: a?.language || s.language || null,
        status: a?.status || null,
        publishedAt: a?.publishedAt || null,
        totalViews: s.totalViews || 0,
        totalUniqueReaders: s.totalUniqueReaders || 0,
        totalEngagedReads: s.totalEngagedReads || 0,
        avgReadTimeSec: s.avgReadTimeSec || 0,
        completionRate: s.completionRate || 0,
      };
    });

    return res.status(200).json({ ok: true, items, total, page, pageSize });
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

async function listCategories(req, res) {
  try {
    if (!isDbReady()) return res.status(200).json({ ok: true, items: [] });

    const rows = await ArticleAnalyticsSummary.aggregate([
      {
        $group: {
          _id: '$category',
          views: { $sum: '$totalViews' },
          uniqueReaders: { $sum: '$totalUniqueReaders' },
          engagedReads: { $sum: '$totalEngagedReads' },
          totalReadTimeSec: { $sum: '$totalReadTimeSec' },
          scroll100: { $sum: '$scroll100Count' },
        },
      },
      { $sort: { views: -1 } },
    ]);

    const items = [];
    for (const r of rows || []) {
      const category = r?._id || null;
      if (!category) continue;

      const views = r.views || 0;
      const top = await ArticleAnalyticsSummary.find({ category }).sort({ totalViews: -1 }).limit(3).lean();
      const ids = top.map((x) => x.articleId);
      const arts = await Article.find({ _id: { $in: ids } }).select('title slug status publishedAt').lean();
      const byId = new Map(arts.map((a) => [String(a._id), a]));

      items.push({
        category,
        views,
        uniqueReaders: r.uniqueReaders || 0,
        engagedReads: r.engagedReads || 0,
        avgReadTimeSec: views > 0 ? (r.totalReadTimeSec || 0) / views : 0,
        completionRate: views > 0 ? (r.scroll100 || 0) / views : 0,
        topArticles: top.map((s) => {
          const a = byId.get(String(s.articleId)) || null;
          return {
            articleId: String(s.articleId),
            title: a?.title || null,
            slug: a?.slug || s.slug || null,
            status: a?.status || null,
            publishedAt: a?.publishedAt || null,
            totalViews: s.totalViews || 0,
          };
        }),
      });
    }

    return res.status(200).json({ ok: true, items });
  } catch (e) {
    console.error('[admin-analytics][categories] failed', e?.message || e);
    return res.status(200).json({ ok: true, items: [] });
  }
}

module.exports = {
  getDashboard,
  listArticles,
  getArticleDetails,
  listCategories,
};
