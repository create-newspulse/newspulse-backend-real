const mongoose = require('mongoose');
const News = require('../models/News');
const Article = require('../models/Article');
const User = require('../models/User');
const { buildPubliclyVisiblePublicArticleFilter } = require('../services/publicArticleVisibility.service');
const { getCanonicalPublicCategoryKey } = require('../lib/categories');

const CONFIGURED_CATEGORY_VALUES = Array.isArray(Article.CATEGORY_VALUES) ? Article.CATEGORY_VALUES.slice() : [];
const CONFIGURED_LANGUAGE_VALUES = Array.isArray(Article.LANGUAGE_VALUES) ? Article.LANGUAGE_VALUES.slice() : ['en', 'hi', 'gu'];

function getKiranOSLogModel() {
  try {
    // eslint-disable-next-line global-require
    return require('../models/KiranOSLog');
  } catch (_) {
    return null;
  }
}

function isMongoConnected() {
  try {
    return Boolean(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
  } catch (_) {
    return false;
  }
}

async function safeCountDocuments(model, filter = {}) {
  try {
    if (!model || typeof model.countDocuments !== 'function') return 0;
    return Number(await model.countDocuments(filter)) || 0;
  } catch (_) {
    return 0;
  }
}

async function safeAggregate(model, pipeline) {
  try {
    if (!model || typeof model.aggregate !== 'function') return [];
    const rows = await model.aggregate(pipeline);
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function configuredItems(values, { keyName, keyTransform } = {}) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      const normalized = keyTransform ? keyTransform(value) : value;
      const key = String(normalized || '').trim();
      if (!key) return null;
      return { [keyName || 'name']: key };
    })
    .filter(Boolean)
    .sort((a, b) => String(a[keyName || 'name']).localeCompare(String(b[keyName || 'name'])));
}

function mergeRows(rows, keyTransform) {
  const merged = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawKey = row && row._id !== undefined && row._id !== null ? String(row._id).trim() : '';
    if (!rawKey) continue;
    const transformed = keyTransform ? keyTransform(rawKey) : rawKey;
    const key = String(transformed || '').trim();
    if (!key) continue;
    merged.set(key, (merged.get(key) || 0) + Number(row.count || 0));
  }
  return Array.from(merged.entries()).map(([key, count]) => ({ _id: key, count }));
}

function valueGroupingPipeline(valueExpression, { match } = {}) {
  const pipeline = [];
  if (match && Object.keys(match).length) pipeline.push({ $match: match });
  pipeline.push(
    { $project: { value: valueExpression } },
    { $match: { value: { $ne: null } } },
    { $group: { _id: '$value', count: { $sum: 1 } } }
  );
  return pipeline;
}

function toBreakdownObject(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row && row._id !== undefined && row._id !== null ? String(row._id).trim() : '';
    if (!key) continue;
    out[key] = Number(row.count || 0);
  }
  return out;
}

function rowsToItems(rows, { keyName, keyTransform } = {}) {
  const items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawKey = row && row._id !== undefined && row._id !== null ? String(row._id).trim() : '';
    if (!rawKey) continue;
    const k = keyTransform ? keyTransform(rawKey) : rawKey;
    const count = Number(row.count || 0);
    items.push({ [keyName || 'name']: k, count });
  }
  items.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ak = String(a[keyName || 'name'] || '');
    const bk = String(b[keyName || 'name'] || '');
    return ak.localeCompare(bk);
  });
  return items;
}

function categoryValueExpression() {
  return {
    $cond: [
      { $or: [{ $eq: ['$category', null] }, { $eq: ['$category', ''] }] },
      null,
      { $toLower: { $trim: { input: { $toString: '$category' } } } },
    ],
  };
}

function langValueExpression() {
  return {
    $let: {
      vars: {
        raw: { $ifNull: ['$lang', '$language'] },
      },
      in: {
        $cond: [
          {
            $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }],
          },
          null,
          {
            $toLower: {
              $trim: {
                input: { $toString: '$$raw' },
              },
            },
          },
        ],
      },
    },
  };
}

function statusValueExpression() {
  return {
    $let: {
      vars: {
        raw: { $ifNull: ['$status', 'draft'] },
      },
      in: {
        $cond: [
          { $or: [{ $eq: ['$$raw', null] }, { $eq: ['$$raw', ''] }] },
          'draft',
          {
            $toLower: {
              $trim: {
                input: { $toString: '$$raw' },
              },
            },
          },
        ],
      },
    },
  };
}

function activeUserFilter() {
  return {
    $or: [
      { status: 'active' },
      { status: null },
      { status: { $exists: false } },
    ],
  };
}

function buildDashboardStatDefinitions() {
  return {
    totalNews: 'All CMS News records across every status in the News collection.',
    publishedNews: 'CMS News records where status is published.',
    draftNews: 'CMS News records where status is draft.',
    archivedNews: 'CMS News records where status is archived.',
    latestPublicVisible: 'Public Article records currently visible on public/latest after published, deletion, lock, embargo, and publish-time checks.',
    categoriesCount: 'Distinct categories currently used by public-visible Article records.',
    configuredCategoriesCount: 'Configured category registry from the Article model.',
    activeCategoriesCount: 'Distinct categories present on non-deleted CMS News records.',
    languagesCount: 'Configured supported language codes.',
    activeUsers: 'Users with status active, plus legacy users where status is missing.',
    aiLogs: 'Total KiranOSLog records.',
  };
}

function buildDashboardQueryAudit(now) {
  return {
    totalNews: { model: 'News', operation: 'countDocuments', filter: {} },
    publishedNews: { model: 'News', operation: 'aggregate(status)', status: 'published' },
    draftNews: { model: 'News', operation: 'aggregate(status)', status: 'draft' },
    archivedNews: { model: 'News', operation: 'aggregate(status)', status: 'archived' },
    latestPublicVisible: {
      model: 'Article',
      operation: 'countDocuments',
      filterSummary: {
        status: 'published',
        publishedAt: 'null-or-past',
        evaluatedAt: now.toISOString(),
      },
    },
    categories: {
      configured: { source: 'Article.CATEGORY_VALUES' },
      active: { model: 'News', operation: 'aggregate(category)', filter: { status: { $ne: 'deleted' } } },
      publicVisible: { model: 'Article', operation: 'aggregate(category)', filter: 'buildPubliclyVisiblePublicArticleFilter(now)' },
    },
    languages: {
      configured: { source: 'Article.LANGUAGE_VALUES' },
      active: { model: 'News', operation: 'aggregate(lang/language)', filter: { status: { $ne: 'deleted' } } },
      publicVisible: { model: 'Article', operation: 'aggregate(language)', filter: 'buildPubliclyVisiblePublicArticleFilter(now)' },
    },
    activeUsers: { model: 'User', operation: 'countDocuments', filter: activeUserFilter() },
    aiLogs: { model: 'KiranOSLog', operation: 'countDocuments', filter: {} },
  };
}

function buildEmptyAdminDashboardStatsPayload() {
  const configuredCategoryItems = configuredItems(CONFIGURED_CATEGORY_VALUES, { keyName: 'name' });
  const configuredLanguageItems = configuredItems(CONFIGURED_LANGUAGE_VALUES, {
    keyName: 'code',
    keyTransform: (value) => String(value || '').trim().toUpperCase(),
  });

  return {
    ok: true,
    totals: {
      articles: 0,
      published: 0,
      draft: 0,
      scheduled: 0,
      archived: 0,
      deleted: 0,
      publicVisible: 0,
      latestVisible: 0,
    },
    news: {
      totalRecords: 0,
      published: 0,
      draft: 0,
      scheduled: 0,
      archived: 0,
      deleted: 0,
      publicVisible: 0,
      latestVisible: 0,
    },
    categories: {
      count: 0,
      items: [],
      configured: { count: configuredCategoryItems.length, items: configuredCategoryItems },
      active: { count: 0, items: [] },
      publicVisible: { count: 0, items: [] },
    },
    languages: {
      count: configuredLanguageItems.length,
      items: configuredLanguageItems,
      configured: { count: configuredLanguageItems.length, items: configuredLanguageItems },
      active: { count: 0, items: [] },
      publicVisible: { count: 0, items: [] },
    },
    activeUsers: 0,
    aiLogs: 0,
    statDefinitions: buildDashboardStatDefinitions(),
    queryAudit: buildDashboardQueryAudit(new Date(0)),

    totalNews: 0,
    totalNewsRecords: 0,
    publishedNews: 0,
    draftNews: 0,
    archivedNews: 0,
    latestPublicVisible: 0,
    publicVisibleNews: 0,
    categoriesCount: 0,
    configuredCategoriesCount: configuredCategoryItems.length,
    activeCategoriesCount: 0,
    visibleCategoriesCount: 0,
    activeCategoriesInUseCount: 0,
    languagesCount: configuredLanguageItems.length,
    configuredLanguagesCount: configuredLanguageItems.length,
    activeLanguagesCount: 0,
    visibleLanguagesCount: 0,
    activeUsersCount: 0,
    aiLogsCount: 0,
    categoriesBreakdown: {},
    languagesBreakdown: {},
  };
}

async function buildAdminDashboardStatsPayload({
  dbConnected = isMongoConnected(),
  now = new Date(),
  NewsModel = News,
  ArticleModel = Article,
  UserModel = User,
  KiranOSLogModel = getKiranOSLogModel(),
} = {}) {
  if (!dbConnected) {
    return buildEmptyAdminDashboardStatsPayload();
  }

  const visibleArticleFilter = buildPubliclyVisiblePublicArticleFilter({ now });
  const activeNewsFilter = { status: { $ne: 'deleted' } };
  const activeArticleFilter = { status: 'published' };

  const [
    totalNewsRecords,
    statusRows,
    activeNewsCategoryRowsRaw,
    activeNewsLanguageRowsRaw,
    publicVisibleCount,
    publicVisibleCategoryRowsRaw,
    publicVisibleLanguageRowsRaw,
    activeUsers,
    aiLogs,
  ] = await Promise.all([
    safeCountDocuments(NewsModel, {}),
    safeAggregate(NewsModel, [
      { $project: { statusValue: statusValueExpression() } },
      { $group: { _id: '$statusValue', count: { $sum: 1 } } },
    ]),
    safeAggregate(NewsModel, valueGroupingPipeline(categoryValueExpression(), { match: activeNewsFilter })),
    safeAggregate(NewsModel, valueGroupingPipeline(langValueExpression(), { match: activeNewsFilter })),
    safeCountDocuments(ArticleModel, visibleArticleFilter),
    safeAggregate(ArticleModel, valueGroupingPipeline(categoryValueExpression(), { match: visibleArticleFilter })),
    safeAggregate(ArticleModel, valueGroupingPipeline(langValueExpression(), { match: visibleArticleFilter })),
    safeCountDocuments(UserModel, activeUserFilter()),
    safeCountDocuments(KiranOSLogModel, {}),
  ]);

  const statusBreakdown = toBreakdownObject(statusRows);
  const totals = {
    articles: Number(totalNewsRecords || 0),
    published: Number(statusBreakdown.published || 0),
    draft: Number(statusBreakdown.draft || 0),
    scheduled: Number(statusBreakdown.scheduled || 0),
    archived: Number(statusBreakdown.archived || 0),
    deleted: Number(statusBreakdown.deleted || 0),
    publicVisible: Number(publicVisibleCount || 0),
    latestVisible: Number(publicVisibleCount || 0),
  };

  const activeNewsCategoryRows = mergeRows(activeNewsCategoryRowsRaw, getCanonicalPublicCategoryKey);
  const publicVisibleCategoryRows = mergeRows(publicVisibleCategoryRowsRaw, getCanonicalPublicCategoryKey);
  const activeNewsLanguageRows = mergeRows(activeNewsLanguageRowsRaw, (value) => String(value || '').trim().toLowerCase());
  const publicVisibleLanguageRows = mergeRows(publicVisibleLanguageRowsRaw, (value) => String(value || '').trim().toLowerCase());

  const activeCategoryItems = rowsToItems(activeNewsCategoryRows, { keyName: 'name' });
  const publicVisibleCategoryItems = rowsToItems(publicVisibleCategoryRows, { keyName: 'name' });
  const activeLanguageItems = rowsToItems(activeNewsLanguageRows, {
    keyName: 'code',
    keyTransform: (value) => String(value || '').trim().toUpperCase(),
  });
  const publicVisibleLanguageItems = rowsToItems(publicVisibleLanguageRows, {
    keyName: 'code',
    keyTransform: (value) => String(value || '').trim().toUpperCase(),
  });

  const configuredCategoryItems = configuredItems(CONFIGURED_CATEGORY_VALUES, { keyName: 'name' });
  const configuredLanguageItems = configuredItems(CONFIGURED_LANGUAGE_VALUES, {
    keyName: 'code',
    keyTransform: (value) => String(value || '').trim().toUpperCase(),
  });

  const categoriesBreakdown = toBreakdownObject(publicVisibleCategoryRows);
  const languagesBreakdown = toBreakdownObject(publicVisibleLanguageRows);

  return {
    ok: true,
    totals,
    news: {
      totalRecords: totals.articles,
      published: totals.published,
      draft: totals.draft,
      scheduled: totals.scheduled,
      archived: totals.archived,
      deleted: totals.deleted,
      publicVisible: totals.publicVisible,
      latestVisible: totals.latestVisible,
    },
    categories: {
      count: publicVisibleCategoryItems.length,
      items: publicVisibleCategoryItems,
      configured: { count: configuredCategoryItems.length, items: configuredCategoryItems },
      active: { count: activeCategoryItems.length, items: activeCategoryItems },
      publicVisible: { count: publicVisibleCategoryItems.length, items: publicVisibleCategoryItems },
    },
    languages: {
      count: configuredLanguageItems.length,
      items: configuredLanguageItems.map((item) => ({
        ...item,
        activeCount: Number(toBreakdownObject(activeNewsLanguageRows)[String(item.code || '').trim().toLowerCase()] || 0),
        publicVisibleCount: Number(toBreakdownObject(publicVisibleLanguageRows)[String(item.code || '').trim().toLowerCase()] || 0),
      })),
      configured: { count: configuredLanguageItems.length, items: configuredLanguageItems },
      active: { count: activeLanguageItems.length, items: activeLanguageItems },
      publicVisible: { count: publicVisibleLanguageItems.length, items: publicVisibleLanguageItems },
    },
    activeUsers: Number(activeUsers || 0),
    aiLogs: Number(aiLogs || 0),
    statDefinitions: buildDashboardStatDefinitions(),
    queryAudit: buildDashboardQueryAudit(now),

    totalNews: totals.articles,
    totalNewsRecords: totals.articles,
    publishedNews: totals.published,
    draftNews: totals.draft,
    archivedNews: totals.archived,
    latestPublicVisible: totals.latestVisible,
    publicVisibleNews: totals.publicVisible,
    categoriesCount: publicVisibleCategoryItems.length,
    configuredCategoriesCount: configuredCategoryItems.length,
    activeCategoriesCount: activeCategoryItems.length,
    visibleCategoriesCount: publicVisibleCategoryItems.length,
    activeCategoriesInUseCount: publicVisibleCategoryItems.length,
    languagesCount: configuredLanguageItems.length,
    configuredLanguagesCount: configuredLanguageItems.length,
    activeLanguagesCount: activeLanguageItems.length,
    visibleLanguagesCount: publicVisibleLanguageItems.length,
    activeUsersCount: Number(activeUsers || 0),
    aiLogsCount: Number(aiLogs || 0),
    categoriesBreakdown,
    languagesBreakdown,
  };
}

// GET /api/admin/dashboard/stats
async function getAdminDashboardStats(req, res) {
  try {
    const payload = await buildAdminDashboardStatsPayload();

    if (String(process.env.DEBUG_DASHBOARD_STATS || '').trim() === '1' && String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      try {
        console.log('[admin-dashboard-stats] model=News collection=%s totals=%j', News.collection?.name || 'unknown', payload.totals);
      } catch (_) {}
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin-dashboard-stats] failed', e?.message || e);
    return res.status(200).json(buildEmptyAdminDashboardStatsPayload());
  }
}

module.exports = {
  getAdminDashboardStats,
  buildAdminDashboardStatsPayload,
  buildEmptyAdminDashboardStatsPayload,
};
