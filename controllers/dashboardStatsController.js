const News = require('../models/News');
const User = require('../models/User');
const CommunitySubmission = require('../models/CommunitySubmission');

async function safeCount(model, filter = {}) {
  try {
    if (!model || !model.countDocuments) return 0;
    return await model.countDocuments(filter);
  } catch (e) {
    console.error('[stats] count failed', { model: model && model.modelName, filter, error: e?.message || e });
    return 0;
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
  const payload = {
    service: 'newspulse-backend',
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    version: getVersion(),
    env: process.env.NODE_ENV || 'development',
  };
  res.status(200).json({ success: true, ok: true, data: payload });
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
