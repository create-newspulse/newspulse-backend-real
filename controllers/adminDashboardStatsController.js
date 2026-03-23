const mongoose = require('mongoose');
const News = require('../models/News');

function isMongoConnected() {
  try {
    return Boolean(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
  } catch (_) {
    return false;
  }
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

// GET /api/admin/dashboard/stats
async function getAdminDashboardStats(req, res) {
  try {
    if (!isMongoConnected()) {
      return res.status(200).json({
        ok: true,
        totals: {
          articles: 0,
          published: 0,
          draft: 0,
          scheduled: 0,
          archived: 0,
          deleted: 0,
        },
        categories: { count: 0, items: [] },
        languages: { count: 0, items: [] },
        activeUsers: 0,
        aiLogs: 0,

        // Backward-compatible fields for existing admin builds
        totalNews: 0,
        publishedNews: 0,
        categoriesCount: 0,
        languagesCount: 0,
        categoriesBreakdown: {},
        languagesBreakdown: {},
      });
    }

    const KiranOSLog = (() => {
      try {
        // eslint-disable-next-line global-require
        return require('../models/KiranOSLog');
      } catch (_) {
        return null;
      }
    })();

    const [totalArticles, statusRows, categoryRows, languageRows, aiLogs] = await Promise.all([
      News.countDocuments({}),
      News.aggregate([
        { $project: { statusValue: statusValueExpression() } },
        { $group: { _id: '$statusValue', count: { $sum: 1 } } },
      ]),
      News.aggregate([
        {
          $project: {
            categoryValue: {
              $cond: [
                { $or: [{ $eq: ['$category', null] }, { $eq: ['$category', ''] }] },
                null,
                { $toLower: { $trim: { input: { $toString: '$category' } } } },
              ],
            },
          },
        },
        { $match: { categoryValue: { $ne: null } } },
        { $group: { _id: '$categoryValue', count: { $sum: 1 } } },
      ]),
      News.aggregate([
        { $project: { langValue: langValueExpression() } },
        { $match: { langValue: { $ne: null } } },
        { $group: { _id: '$langValue', count: { $sum: 1 } } },
      ]),
      KiranOSLog && KiranOSLog.countDocuments ? KiranOSLog.countDocuments({}) : 0,
    ]);

    const statusBreakdown = toBreakdownObject(statusRows);
    const totals = {
      articles: Number(totalArticles || 0),
      published: Number(statusBreakdown.published || 0),
      draft: Number(statusBreakdown.draft || 0),
      scheduled: Number(statusBreakdown.scheduled || 0),
      archived: Number(statusBreakdown.archived || 0),
      deleted: Number(statusBreakdown.deleted || 0),
    };

    const categoriesItems = rowsToItems(categoryRows, { keyName: 'name' });
    const languagesItems = rowsToItems(languageRows, {
      keyName: 'code',
      keyTransform: (s) => String(s).trim().toUpperCase(),
    });
    const categories = { count: categoriesItems.length, items: categoriesItems };
    const languages = { count: languagesItems.length, items: languagesItems };

    const categoriesBreakdown = toBreakdownObject(categoryRows);
    const languagesBreakdown = toBreakdownObject(languageRows);

    const payload = {
      ok: true,
      totals,
      categories,
      languages,
      activeUsers: 0,
      aiLogs: Number(aiLogs || 0),

      // Backward-compatible fields for existing admin builds
      totalNews: totals.articles,
      publishedNews: totals.published,
      categoriesCount: categories.count,
      languagesCount: languages.count,
      categoriesBreakdown,
      languagesBreakdown,
    };

    if (String(process.env.DEBUG_DASHBOARD_STATS || '').trim() === '1' && String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      try {
        console.log('[admin-dashboard-stats] model=News collection=%s totals=%j', News.collection?.name || 'unknown', totals);
      } catch (_) {}
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin-dashboard-stats] failed', e?.message || e);
    return res.status(200).json({
      ok: true,
      totals: {
        articles: 0,
        published: 0,
        draft: 0,
        scheduled: 0,
        archived: 0,
        deleted: 0,
      },
      categories: { count: 0, items: [] },
      languages: { count: 0, items: [] },
      activeUsers: 0,
      aiLogs: 0,

      // Backward-compatible fields for existing admin builds
      totalNews: 0,
      publishedNews: 0,
      categoriesCount: 0,
      languagesCount: 0,
      categoriesBreakdown: {},
      languagesBreakdown: {},
    });
  }
}

module.exports = { getAdminDashboardStats };
