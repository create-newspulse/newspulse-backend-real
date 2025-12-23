const News = require('../models/News');
const User = require('../models/User');
const CommunitySubmission = require('../models/CommunitySubmission');

function safeRequire(path) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(path);
  } catch (_) {
    return null;
  }
}

async function safeCount(model, filter = {}) {
  try {
    if (!model || !model.countDocuments) return 0;
    // Prevent Mongoose buffering timeouts when DB is not connected.
    if (model.db && model.db.readyState !== 1) return 0;
    return await model.countDocuments(filter);
  } catch (e) {
    console.error('[stats] count failed', { model: model && model.modelName, filter, error: e?.message || e });
    return 0;
  }
}

async function safeAggregate(model, pipeline) {
  try {
    if (!model || !model.aggregate) return [];
    // Prevent Mongoose buffering timeouts when DB is not connected.
    if (model.db && model.db.readyState !== 1) return [];
    const rows = await model.aggregate(pipeline);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('[stats] aggregate failed', { model: model && model.modelName, error: e?.message || e });
    return [];
  }
}

function getVersion() {
  try {
    const pkg = require('../package.json');
    return pkg.version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

// GET /stats
exports.getSystemStats = async (req, res) => {
  // Dashboard-friendly stats payload (real DB counts; no demo data)
  // Required keys: totalNews, categories, languages, activeUsers, aiLogs
  const AiLog = safeRequire('../models/AiLog');

  const nonDeletedNewsFilter = { status: { $ne: 'deleted' } };

  const [
    totalNews,
    activeUsers,
    aiLogs,
    categories,
    languages,
  ] = await Promise.all([
    safeCount(News, nonDeletedNewsFilter),
    safeCount(User, { status: 'active' }),
    safeCount(AiLog, {}),
    (async () => {
      const rows = await safeAggregate(News, [
        { $match: nonDeletedNewsFilter },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $project: { _id: 0, category: '$_id', count: 1 } },
        { $sort: { count: -1, category: 1 } },
      ]);
      return rows
        .filter((r) => r && typeof r.count === 'number')
        .map((r) => ({ category: r.category ?? null, count: r.count }));
    })(),
    (async () => {
      const rows = await safeAggregate(News, [
        { $match: nonDeletedNewsFilter },
        { $group: { _id: '$language', count: { $sum: 1 } } },
        { $project: { _id: 0, language: '$_id', count: 1 } },
        { $sort: { count: -1, language: 1 } },
      ]);
      return rows
        .filter((r) => r && typeof r.count === 'number')
        .map((r) => ({ language: r.language ?? null, count: r.count }));
    })(),
  ]);

  return res.status(200).json({
    ok: true,
    success: true,
    data: {
      totalNews,
      categories,
      languages,
      activeUsers,
      aiLogs,
    },
  });
};

// GET /dashboard-stats
exports.getDashboardStats = async (req, res) => {
  try {
    const [
      totalArticles,
      publishedArticles,
      draftArticles,
      breakingNewsCount,
      totalUsers,
      adminUsers,
      activeReporters,
      pendingReporterRequests,
      storiesLast7Days,
    ] = await Promise.all([
      safeCount(News, {}),
      safeCount(News, { status: 'published' }),
      safeCount(News, { status: 'draft' }),
      safeCount(News, { tags: { $in: ['breaking'] } }),
      safeCount(User, {}),
      safeCount(User, { role: 'admin' }),
      // Heuristics: community submissions with status 'approved' as active reporters
      safeCount(CommunitySubmission, { status: 'approved' }),
      // Pending reporter verification requests
      safeCount(CommunitySubmission, { status: 'under_review' }),
      (async () => {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return safeCount(CommunitySubmission, { createdAt: { $gte: since } });
      })(),
    ]);

    const payload = {
      totalArticles,
      publishedArticles,
      draftArticles,
      breakingNewsCount,
      totalUsers,
      adminUsers,
      activeReporters,
      pendingReporterRequests,
      storiesLast7Days,
    };

    res.status(200).json({ success: true, ok: true, data: payload });
  } catch (e) {
    console.error('[dashboard-stats] failed', e?.message || e);
    res.status(200).json({
      success: true,
      ok: true,
      data: {
        totalArticles: 0,
        publishedArticles: 0,
        draftArticles: 0,
        breakingNewsCount: 0,
        totalUsers: 0,
        adminUsers: 0,
        activeReporters: 0,
        pendingReporterRequests: 0,
        storiesLast7Days: 0,
      },
    });
  }
};
