const Article = require('../models/Article');

function isMongoConnected() {
  try {
    return Boolean(Article && Article.db && Article.db.readyState === 1);
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

// GET /api/admin/dashboard/stats
async function getAdminDashboardStats(req, res) {
  try {
    if (!isMongoConnected()) {
      return res.status(200).json({
        ok: true,
        totalNews: 0,
        publishedNews: 0,
        categoriesCount: 0,
        languagesCount: 0,
        categoriesBreakdown: {},
        languagesBreakdown: {},
      });
    }

    const publishedMatch = { status: 'published' };

    const [totalNews, publishedNews, categoryRows, languageRows] = await Promise.all([
      Article.countDocuments({}),
      Article.countDocuments(publishedMatch),
      Article.aggregate([
        { $match: publishedMatch },
        {
          $project: {
            category: {
              $cond: [
                { $or: [{ $eq: ['$category', null] }, { $eq: ['$category', ''] }] },
                null,
                { $toLower: { $trim: { input: { $toString: '$category' } } } },
              ],
            },
          },
        },
        { $match: { category: { $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      Article.aggregate([
        { $match: publishedMatch },
        { $project: { langValue: langValueExpression() } },
        { $match: { langValue: { $ne: null } } },
        { $group: { _id: '$langValue', count: { $sum: 1 } } },
      ]),
    ]);

    const categoriesBreakdown = toBreakdownObject(categoryRows);
    const languagesBreakdown = toBreakdownObject(languageRows);

    return res.status(200).json({
      ok: true,
      totalNews: Number(totalNews || 0),
      publishedNews: Number(publishedNews || 0),
      categoriesCount: Object.keys(categoriesBreakdown).length,
      languagesCount: Object.keys(languagesBreakdown).length,
      categoriesBreakdown,
      languagesBreakdown,
    });
  } catch (e) {
    console.error('[admin-dashboard-stats] failed', e?.message || e);
    return res.status(200).json({
      ok: true,
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
