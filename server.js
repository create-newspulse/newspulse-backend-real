const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Base dir for nested app code
const BASE = './newspulse-backend-real-main';

// Nested routes and modules
const newsRoutes = require(`${BASE}/routes/news`);
const articlesRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const adminAuthRoutes = require(`${BASE}/routes/adminAuth`);
const aiTrainingInfoRoutes = require(`${BASE}/routes/system/aiTrainingInfo`);
const systemHealthRoutes = require(`${BASE}/routes/system/health`);
const systemRoutesRouter = require('./routes/system.routes');
const systemRoutes = require('./routes/system');
const communityRoutes = require(`${BASE}/routes/community`);
const communityStoriesRouter = require('./routes/communityStories');
const adminCommunityRoutes = require(`${BASE}/routes/adminCommunity`);
const communityAdminContactsRoutes = require(`${BASE}/routes/communityAdminContacts`);
// Use root-level communityReporter routes to match tests
const communityReporterRoutes = require('./routes/communityReporter');
const { getCommunityReporterQueue, listReporterContacts } = require('./controllers/communityReporterController');
const adminSettingsRoutes = require(`${BASE}/routes/adminSettings`);
const communityReporterSettingsRouter = require(`${BASE}/routes/adminSettings/communityReporterSettings`);
// Dashboard stats router lives in root-level routes, not nested BASE dir
const dashboardStatsRouter = require('./routes/dashboardStats');
const adminCommunityReporterQueueRouter = require('./routes/admin/communityReporterQueue');
const CommunitySubmission = require(`${BASE}/models/CommunitySubmission`);
const News = require(`${BASE}/models/News`);
const { requireAdminAuth } = require('./middleware/adminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require(`${BASE}/routes/ai`); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require(`${BASE}/routes/feed`); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }
let publicCommunitySettingsRouter = null;
try { publicCommunitySettingsRouter = require(`${BASE}/routes/public/communitySettings`); } catch (_) { console.warn('[init] optional public community settings router not found; skipping'); }

dotenv.config();

const app = express();

// Global CORS middleware (admin panel + Vercel domains)
const allowedOrigins = [
  // Local dev admin panel
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Known admin/public deployments
  'https://newspulse-admin-panel-real-main.vercel.app',
  'https://newspulse-frontend-live.vercel.app',
  // Custom domains (if frontends are mapped)
  'https://admin.newspulse.co.in',
  'https://newspulse.co.in',
  // Backend host
  'https://newspulse-backend-real-main.onrender.com',
];

function isAllowedOrigin(origin) {
  try {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    const lower = origin.toLowerCase();
    // Allow any Vercel preview/production domain
    if (lower.endsWith('.vercel.app')) return true;
    // Allow Render-hosted backends
    if (lower.endsWith('.onrender.com')) return true;
    // Allow common localhost variations
    if (lower.startsWith('http://localhost:')) return true;
    if (lower.startsWith('http://127.0.0.1:')) return true;
    return false;
  } catch (_) {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser/server-to-server calls (no origin)
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      try { console.warn('[CORS] Blocked origin:', origin); } catch (_) {}
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.options('*', cors());

app.use(express.json());

// Mount small system router for admin dashboard health + AI debug
app.use('/system', systemRoutes);
app.use('/api/system', systemRoutes);

// Lightweight system endpoints
app.get('/system/health', (req, res) => {
  res.json({ ok: true, status: 'online', env: process.env.NODE_ENV || 'development', uptime: process.uptime() });
});
app.get('/system/ai-training-info', (req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString() });
});

// Root-level health and stats (no /api prefix)
// These are defined directly on the app instance and must appear
// before any 404/error handlers so they are always reachable.
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'newspulse-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/stats', (req, res) => {
  try {
    return res.status(200).json({
      status: 'ok',
      service: 'newspulse-backend',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[root:/stats] failed', e?.message || e);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
});

app.get('/dashboard-stats', async (req, res) => {
  try {
    // Placeholder values; wire up real MongoDB counts later.
    return res.status(200).json({
      status: 'ok',
      totalArticles: 0,
      publishedArticles: 0,
      draftArticles: 0,
      breakingNewsCount: 0,
      totalUsers: 0,
      adminUsers: 0,
      activeReporters: 0,
      pendingReporterRequests: 0,
      storiesLast7Days: 0,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[root:/dashboard-stats] failed', e?.message || e);
    return res.status(500).json({ status: 'error', message: 'Failed to load dashboard stats' });
  }
});

// Mongo
const MONGO_URI = process.env.MONGO_URI;
if (process.env.NODE_ENV === 'test') {
  console.warn('[init] Test mode: skipping MongoDB connection');
} else if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.warn('⚠️ MONGO_URI is not set correctly; starting server without DB connection for now.');
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
    });
}

// Home
app.get('/', (req, res) => { res.send('🟢 News Pulse Admin Backend is Live'); });

// API Routes
app.use('/api/news', newsRoutes);
// Articles router mounted at /api and alias at root for /articles
app.use('/api', articlesRoutes);
app.use('/', articlesRoutes);
app.use('/api/community', communityRoutes);
// Reporter portal: My Community Stories
app.use('/api/community', communityStoriesRouter);
// PUBLIC routes – must be before any /api auth-protected mounts
app.get('/api/community-reporter/queue', getCommunityReporterQueue);
app.get('/api/community-reporter/contacts', listReporterContacts);
// Admin UI often calls these aliases; expose public read-only directory
app.get('/api/admin/community/reporter-contacts', listReporterContacts);
app.get('/admin-api/admin/community/reporter-contacts', listReporterContacts);
app.use('/api/community-reporter', communityReporterRoutes);
// Public alias to match frontend expectation
app.use('/api/public/community-reporter', communityReporterRoutes);
// Public community settings
if (publicCommunitySettingsRouter) {
  app.use('/api/public/community', publicCommunitySettingsRouter);
}
// Journalists public/apply + admin ops
try {
  const journalistsRouter = require('./routes/journalists');
  app.use('/api/journalists', journalistsRouter);
} catch (e) {
  console.warn('[init] optional routes/journalists not found; skipping');
}
// Admin routes for legacy and new admin UI paths
app.use('/api/admin', adminRoutes); // used by admin UI
app.use('/admin', adminRoutes);     // legacy path
// Mount dashboard stats router
// /api -> /api/stats, /api/dashboard-stats
app.use('/api', dashboardStatsRouter);
// /admin-api -> alias used by some frontends
app.use('/admin-api', dashboardStatsRouter);
// /api/admin -> explicit admin-prefixed endpoints
app.use('/api/admin', dashboardStatsRouter);
app.use('/admin-auth', adminAuthRoutes);
app.use('/system/ai-training-info', aiTrainingInfoRoutes);
app.use('/api/system/ai-training-info', aiTrainingInfoRoutes);
// Admin-prefixed alias for system AI training info
app.use('/api/admin/system/ai-training-info', aiTrainingInfoRoutes);
app.use('/api/system/health', systemHealthRoutes);
app.use('/system/health', systemHealthRoutes);
// System monitor hub (API + non-API alias)
app.use('/api/system', systemRoutesRouter);
app.use('/system', systemRoutesRouter);
// Admin-prefixed alias for system routes (ensures /api/admin/system/health via mounted router)
app.use('/api/admin/system', systemRoutesRouter);
app.use('/api/admin/community', adminCommunityRoutes);
// Admin Settings (includes /api/admin/settings/community-reporter)
app.use('/api/admin', adminSettingsRoutes);
app.use('/admin-api/admin', adminSettingsRoutes);
// Community Reporter Settings router (same mount /api/admin)
app.use('/api/admin', communityReporterSettingsRouter);
// Community Reporter Queue (admin protected)
app.use('/api/admin', adminCommunityReporterQueueRouter);
app.use('/admin-api/admin', adminCommunityReporterQueueRouter);
app.use('/admin', adminCommunityReporterQueueRouter);
// Mount full admin community-reporter routes (submissions, decisions, journalist applications)
try {
  const adminCommunityReporterRouter = require('./routes/adminCommunityReporter');
  app.use('/api/admin/community-reporter', adminCommunityReporterRouter);
  app.use('/admin/community-reporter', adminCommunityReporterRouter);
  // Also mount under /admin/community for journalist applications aliases
  app.use('/admin/community', adminCommunityReporterRouter);
} catch (e) {
  console.warn('[init] optional routes/adminCommunityReporter not found; skipping');
}
if (aiRoutes) app.use('/api/ai', aiRoutes);
if (feedRoutes) app.use('/api/feed', feedRoutes);
app.use('/api/admin/community', communityAdminContactsRoutes);
app.use('/admin-api/admin/community', communityAdminContactsRoutes);
app.use('/admin/community', communityAdminContactsRoutes);
// Admin journalists endpoints
try {
  const adminJournalists = require('./routes/admin/journalistsAdmin');
  app.use('/api/admin', adminJournalists);
} catch (e) {
  console.warn('[init] optional routes/admin/journalistsAdmin not found; skipping');
}

// Lightweight health/status endpoint under /api
// (stats and dashboard-stats are now served by routes/dashboardStats.js mounted under /api and /admin-api)

// Aliases and fallbacks
app.get('/admin/community/journalist-applications', requireAdminAuth, (req, res, next) => {
  try { req.url = '/journalist-applications'; return communityAdminContactsRoutes(req, res, next); } catch (e) {
    console.error('[nested][ALIAS][journalist-applications] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});
app.get('/admin/community/reporter-contacts', requireAdminAuth, async (req, res, next) => {
  if (res.headersSent) return next();
  if (communityAdminContactsRoutes) return next();
  return res.json({ ok: true, items: [], total: 0 });
});
app.get('/admin/community/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKeyRaw = (req.query.reporterKey || '').toString().trim();
    if (!reporterKeyRaw) return res.status(400).json({ ok: false, message: 'Missing reporterKey' });
    const reporterKey = reporterKeyRaw.toLowerCase();
    const pageNum = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const status = (req.query.status || '').toString().trim();

    const baseFilter = {
      $or: [
        { reporterEmail: reporterKey },
        { 'contact.email': reporterKey },
        { email: reporterKey },
      ],
    };
    if (status && status !== 'all') {
      baseFilter.$and = (baseFilter.$and || []).concat([{ status }]);
    }

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(baseFilter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      CommunitySubmission.countDocuments(baseFilter),
    ]);
    const items = docs.map(d => ({
      id: d._id.toString(),
      title: d.headline || '',
      summary: null,
      status: d.status || 'draft',
      language: d.language || 'en',
      category: d.category || null,
      city: (d.location?.city || d.city || d.locationDetail?.city || null),
      createdAt: d.createdAt ? d.createdAt.toISOString() : null,
      updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
      aiRisk: typeof d.riskScore === 'number' ? String(d.riskScore) : null,
      priority: d.priority || null,
    }));
    return res.json({ ok: true, items, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('[ADMIN][reporter-stories] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  const a = req.admin || {};
  return res.json({ success: true, admin: { id: a.id || 'unknown', email: a.email || '', role: a.role || 'admin' } });
});

// Aliases expected by some UIs
app.get('/admin/stats', async (req, res) => {
  try {
    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load admin stats' });
  }
});
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalArticles = await News.countDocuments({});
    return res.json({ ok: true, stats: { totalArticles, timestamp: new Date().toISOString() } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Failed to load admin stats' });
  }
});

// Public config
let _communityReporterFlagCache = { myCommunityStoriesEnabled: false };
app.get('/api/community-reporter/config', (req, res) => {
  return res.json({ ok: true, communityMyStoriesEnabled: _communityReporterFlagCache.myCommunityStoriesEnabled });
});

// --- AI / System health stubs ---
app.get('/api/system/ai-health', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI health stub (no real engine wired yet)',
    data: {
      status: 'offline',
      engines: [],
      notes: 'This is a placeholder response from newspulse-backend-real-main.',
    },
  });
});

app.get('/system/ai-training-info', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI training info stub',
    data: {
      lastUpdated: null,
      datasets: [],
      notes: 'Training info not yet implemented.',
    },
  });
});

// --- AIRA bulletins stub ---
app.get('/api/aira/bulletins', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AIRA bulletins stub',
    data: {
      items: [],
      notes: 'No bulletins yet – backend stub response.',
    },
  });
});

// --- Vault stub ---
app.get('/api/vault/list', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI vault list stub',
    data: {
      items: [],
    },
  });
});

// --- Media uploads stub ---
app.get('/api/uploads', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Uploads list stub',
    data: {
      items: [],
    },
  });
});

// --- SEO audit history stub ---
app.get('/api/seo/audit/history', (req, res) => {
  const limit = Number(req.query.limit || 0);
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'SEO audit history stub',
    data: {
      limit,
      items: [],
    },
  });
});

// --- Analytics stubs ---
app.get('/api/analytics/revenue', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Revenue analytics stub',
    data: {
      total: 0,
      bySource: [],
    },
  });
});

app.get('/api/analytics/traffic', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Traffic analytics stub',
    data: {
      sessions: 0,
      pageViews: 0,
      byChannel: [],
    },
  });
});

app.get('/api/analytics/ad-performance', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Ad performance stub',
    data: {
      campaigns: [],
    },
  });
});

app.get('/api/analytics/ab-tests', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'A/B tests stub',
    data: {
      experiments: [],
    },
  });
});

// --- System version log stub ---
app.get('/api/system/version-log', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Version log stub',
    data: {
      items: [],
      notes: 'No version log entries yet on backend.',
    },
  });
});

// --- Threat stats stub ---
app.get('/threat-stats', (req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    message: 'Threat stats stub',
    data: {
      level: 'normal',
      lastScan: null,
      issues: [],
    },
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, success: false, status: 404, message: 'Route not found', path: req.originalUrl });
});

// 500
app.use((err, req, res, next) => {
  try { console.error('Error:', err && err.message ? err.message : err, 'path=', req.originalUrl); } catch (_) {}
  res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
});

// Start server only when invoked directly (not when imported by tests)
const PORT = process.env.PORT || 5000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    try {
      const reporterRoutes = [];
      app._router && app._router.stack && app._router.stack.forEach(layer => {
        if (layer.route && layer.route.path && layer.route.path.includes('reporter')) {
          reporterRoutes.push(layer.route.path);
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
          const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
          layer.handle.stack.forEach(rLayer => {
            if (rLayer.route && rLayer.route.path && rLayer.route.path.includes('reporter')) {
              reporterRoutes.push(prefix + rLayer.route.path);
            }
          });
        }
      });
      console.log('[startup][reporter-routes]', reporterRoutes);
    } catch (e) {
      console.warn('[startup][reporter-routes] failed', e?.message || e);
    }
  });
}

function extractPrefix(regexp) {
  try {
    const src = (regexp && regexp.source) || '';
    const m = src.match(/\\\/(admin[^\\^]+|api[^\\^]+|system[^\\^]+)/i);
    if (m && m[1]) return '/' + m[1];
  } catch (_) {}
  return '';
}

// Debug routes list
// Debug routes list (place before 404 handler)
app.get('/_debug/routes', (req, res) => {
  const list = [];
  try {
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path) {
        list.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => { if (rLayer.route && rLayer.route.path) list.push(prefix + rLayer.route.path); });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Introspection failed', error: e?.message || e });
  }
  return res.json({ ok: true, total: list.length, reporter: list.filter(r => r.includes('reporter')), all: list });
});

module.exports = app;
