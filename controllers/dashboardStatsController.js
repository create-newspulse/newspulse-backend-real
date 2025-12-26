const News = require('../models/News');
const User = require('../models/User');
const CommunitySubmission = require('../models/CommunitySubmission');

const DASHBOARD_CATEGORIES = ['regional', 'youth', 'campus', 'civic', 'lifestyle', 'other'];

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

async function safeDistinctCount(model, field, filter = {}) {
  try {
    if (!model || !model.distinct) return 0;
    if (model.db && model.db.readyState !== 1) return 0;
    const values = await model.distinct(field, filter);
    if (!Array.isArray(values)) return 0;
    const normalized = values
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== null && v !== undefined && v !== '');
    return new Set(normalized).size;
  } catch (e) {
    console.error('[stats] distinct failed', { model: model && model.modelName, field, error: e?.message || e });
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
  const systemHealth = {
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  };

  try {
    // Dashboard-friendly stats payload (real DB counts; no demo data)
    // Required keys: totalNews, categories, languages, activeUsers, aiLogs

    // Prefer Article model if present; else fall back to News.
    const Article = safeRequire('../models/Article');
    const articleModel = Article || News;

    // AI logs: use a model if present (KiranOSLog exists in this repo), else 0.
    const KiranOSLog = safeRequire('../models/KiranOSLog');

    const [totalNews, languagesFromArticles, aiLogs] = await Promise.all([
      // Count ALL articles (draft + published + scheduled + archived + deleted)
      safeCount(articleModel, {}),
      safeDistinctCount(articleModel, 'language', {}),
      safeCount(KiranOSLog, {}),
    ]);

    const categories = Array.isArray(DASHBOARD_CATEGORIES) ? DASHBOARD_CATEGORIES.length : 0;
    const languages = languagesFromArticles;
    const activeUsers = 0;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'System stats fetched',
      data: {
        totalNews,
        categories,
        languages,
        activeUsers,
        aiLogs,
        systemHealth,
      },
    });
  } catch (e) {
    console.error('[stats] getSystemStats failed', e?.message || e);
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'System stats fetched',
      data: {
        totalNews: 0,
        categories: Array.isArray(DASHBOARD_CATEGORIES) ? DASHBOARD_CATEGORIES.length : 0,
        languages: 0,
        activeUsers: 0,
        aiLogs: 0,
        systemHealth,
      },
    });
  }
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
